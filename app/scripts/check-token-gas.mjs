// Phase 13 item 2, app half: paying a smart-account send's network fee in
// USDC through Circle's token paymaster (app/src/wallet/token-gas.ts and the
// USDC-fee branch of app/src/wallet/aa.ts sendAa), entirely OFFLINE.
//
// What is exercised, against fakes only (nothing touches a network):
//  - where the choice is offered (profile, account type, sponsorship,
//    passkey, readiness) and the on-chain paymaster check with its cache;
//  - the quote's worst case, recomputed here independently from the
//    paymaster's fee formula (not with the engine helpers under test);
//  - funding refusals and the Max math for ETH, USDC and another token;
//  - the full quote -> gate -> estimate -> sign -> send pipeline with a real
//    seed-derived owner: the stub permit and the final permit are recovered
//    through an EMULATION of Kernel v3.3's ERC-1271 envelope (owner recovered
//    with ethers, fakes-kernel.mjs), the stub permit equals the displayed
//    worst case exactly, the final permit is the post-estimate worst case and
//    never above it, and the userOp signature recovers to the owner;
//  - the cap: a price rise refuses before anything is signed, an estimate
//    above the ceiling refuses before the final signature;
//  - receipt decoding of Circle's UserOperationSponsored event (encoded with
//    ethers, independently of the engine decoder);
//  - the three follow-ups: the token chain guard in aa.ts, tracked tokens in
//    the subscription token list, and WcApprovalSheet's explicit chain.
//
// Run from the app directory:
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-token-gas.mjs

import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  CIRCLE_TOKEN_PAYMASTER_V07,
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  TokenGasChargeAboveLimitError,
  getUserOpHash,
  selector,
  toBytes,
  toHex,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREVIEW_AA_NOTE } from '../src/wallet/simulation.ts';
import {
  AA_FUNDING_TITLE,
  AaFundingError,
  PREVIEW_AA_BATCH_NOTE,
  aaPreviewNote,
  describeAaError,
  TOKEN_GAS_ACCOUNT_REFUSAL,
  TOKEN_GAS_ESTIMATION_CEILING,
  TOKEN_GAS_PADDING_PCT,
  assertTokenGasPermit,
  createAaClient,
  maxAaErc20Send,
  prepareAaErc20Send,
  prepareAaSend,
  sendAa,
  AaFeeRoseError,
  AA_QUOTE_ALREADY_USED,
  aaErc20TransferCalls,
  aaRiskWarningTarget,
  aaUserCalls,
} from '../src/wallet/aa.ts';
import {
  TOKEN_GAS_7702_NOTE,
  TOKEN_GAS_CHECK_TTL_MS,
  TOKEN_GAS_ESTIMATE_AFTER_APPROVAL,
  TOKEN_GAS_FEE_ROSE_TITLE,
  TOKEN_GAS_FIXED_ORACLE_NOTE,
  TOKEN_GAS_NOT_CONFIGURED_NOTE,
  TOKEN_GAS_PASSKEY_NOTE,
  TOKEN_GAS_REFUSED_TITLE,
  TOKEN_GAS_SIMPLE_ACCOUNT_NOTE,
  TOKEN_GAS_SPONSORED_NOTE,
  TOKEN_GAS_UNAVAILABLE_TITLE,
  TokenGasUnavailableError,
  checkTokenGasPaymaster,
  describeTokenGasError,
  forgetTokenGasChecks,
  maxAaTokenGasErc20Send,
  maxAaTokenGasSend,
  prepareAaTokenGasErc20Send,
  prepareAaTokenGasSend,
  tokenGasAboveLimitSentence,
  tokenGasChargeFromReceipt,
  tokenGasChargedSentence,
  tokenGasFeeSentence,
  tokenGasGrantSentence,
  tokenGasNotOnNetworkSentence,
  tokenGasOffer,
  tokenGasOracleNote,
  tokenGasPaymasterFor,
  tokenGasRateSentence,
  tokenGasSpreadText,
  settingsTokensFeeSentence,
  tokenSendFeeSentence,
} from '../src/wallet/token-gas.ts';
import { FeatureNotAllowedError, featureReadiness, isFeatureAllowed } from '../src/config/readiness.ts';
import { spendingInputForQuote, validatePolicyList } from '../src/wallet/spending-policy.ts';
import { loadSubscriptionTokenChoices, subscriptionTokenChoices } from '../src/wallet/subscriptions.ts';
import { addToken, knownTokensForChain } from '../src/wallet/tokens.ts';
import {
  KERNEL_ACCOUNT_0,
  OWNER_0,
  TEST_MNEMONIC,
  USEROP_HASH,
  decodeKernelExecute,
  emulateKernelIsValidSignature,
  fakeKernelNode,
  fromRpcOp,
  memoryStore,
} from './fakes-kernel.mjs';

const TG_APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TG_MUTANT_DIR = join(dirname(fileURLToPath(import.meta.url)), `.mutants-tg-${process.pid}`);
let tgMutantCount = 0;
process.on('exit', () => rmSync(TG_MUTANT_DIR, { recursive: true, force: true }));
/** Imports a mutated copy of an app module (relative imports re-pointed at the real files). */
async function importMutantTg(relPath, source) {
  const originalDir = dirname(join(TG_APP_ROOT, relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(TG_MUTANT_DIR, { recursive: true });
  tgMutantCount += 1;
  const file = join(TG_MUTANT_DIR, `m${tgMutantCount}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

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
const fmt6 = (v) => ethers.formatUnits(v, 6).replace(/\.0$/, '');

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
const owner1 = evmKeyProvider.deriveAccount(seed, 0, 1);
seed.fill(0);

const BASE = 'eip155:84532';
const SEPOLIA = 'eip155:11155111';
const MAINNET = 'eip155:1';
const CHAIN_ID = 84532n;
const PAYMASTER = CIRCLE_TOKEN_PAYMASTER_V07.testnetAddress;
const USDC = CIRCLE_TOKEN_PAYMASTER_V07.tokens['84532'];
const EURC = '0x808456652fdb597867f38412077A9182bf77359F';
const IMPLEMENTATION = '0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d';
const ORACLE = '0x74479c39dDAFb0549ED6c26080c6e5D155300a89';
const PRICE = 3_000_000_000n; // 3000.000000 USDC per 1 ETH (the Base Sepolia test oracle, engine notes)
const RECIPIENT = ethers.getAddress('0x' + 'aa'.repeat(20));
const NODE_URL = 'https://node.example';
const BUNDLER_URL = 'https://bundler.example';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const abi = ethers.AbiCoder.defaultAbiCoder();
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad32 = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
const sel = (signature) => toHex(selector(signature));
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
const USDC_DOMAIN = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC };
const SPONSORED_TOPIC = ethers.id('UserOperationSponsored(address,address,bytes32,uint256,uint256,uint256)');
const isValidSigIface = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

/**
 * Fake Base Sepolia node: the Kernel surface from fakes-kernel.mjs plus
 * Circle's paymaster views, the EntryPoint's getDepositInfo, and USDC's
 * EIP-2612 views. `state` is mutable so a test can move the price or a
 * balance between the quote and the send.
 */
function tgNode(opts = {}) {
  const state = {
    price: PRICE,
    spread: 0n,
    extra: 35_000n,
    paused: false,
    entryPoint: ENTRYPOINT_V07,
    token: USDC,
    staked: true,
    deposit: 10n ** 18n,
    permitNonce: 0n,
    baseFee: 5_000_000n, // 0.005 gwei, the order of Base Sepolia's base fee
    priority: 1_000_000n,
    domainOk: true,
    ...opts,
  };
  const tokenBalances = {
    [`${USDC.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`]: opts.usdc ?? 1_000_000n,
    [`${EURC.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`]: opts.eurc ?? 0n,
  };
  const calls = [];
  const inner = fakeKernelNode({
    chainIdHex: opts.chainIdHex ?? '0x14a34',
    balance: opts.eth ?? 10n ** 16n,
    tokenBalances,
    deployedAccounts: opts.deployed ? new Set([KERNEL_ACCOUNT_0]) : new Set(),
    owners: { [KERNEL_ACCOUNT_0.toLowerCase()]: OWNER_0 },
    calls,
  });
  const transport = async (method, params) => {
    if (method === 'eth_getStorageAt' && same(params[0], PAYMASTER) && params[1] === IMPL_SLOT) {
      calls.push({ method, params });
      return pad32(IMPLEMENTATION);
    }
    if (method === 'eth_getBlockByNumber') {
      calls.push({ method, params });
      return { baseFeePerGas: '0x' + state.baseFee.toString(16) };
    }
    if (method === 'eth_maxPriorityFeePerGas') {
      calls.push({ method, params });
      return '0x' + state.priority.toString(16);
    }
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      const answer = (() => {
        if (same(to, PAYMASTER)) {
          if (data === sel('entryPoint()')) return pad32(state.entryPoint);
          if (data === sel('token()')) return pad32(state.token);
          if (data === sel('tokenDecimals()')) return word(6);
          if (data === sel('fetchPrice()')) return word(state.price);
          if (data === sel('additionalGasCharge()')) return word(state.extra);
          if (data === sel('feeSpread()')) return word(state.spread);
          if (data === sel('paused()')) return word(state.paused ? 1 : 0);
          if (data === sel('owner()')) return pad32('0x86665ff7bb7dd39e136cb7838117ca63dcd51461');
          if (data === sel('oracle()')) return pad32(ORACLE);
        }
        if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getDepositInfo(address)'))) {
          return '0x' + [state.deposit, state.staked ? 1n : 0n, state.staked ? 25n * 10n ** 16n : 0n, 86_400n, 0n]
            .map((v) => word(v).slice(2))
            .join('');
        }
        if (same(to, USDC)) {
          if (data === sel('name()')) return abi.encode(['string'], ['USDC']);
          if (data === sel('version()')) return abi.encode(['string'], ['2']);
          if (data.startsWith(sel('nonces(address)'))) return word(state.permitNonce);
          if (data === sel('DOMAIN_SEPARATOR()')) {
            return state.domainOk
              ? ethers.TypedDataEncoder.hashDomain(USDC_DOMAIN)
              : ethers.TypedDataEncoder.hashDomain({ ...USDC_DOMAIN, version: '1' });
          }
          if (data.startsWith(sel('allowance(address,address)'))) return word(0);
        }
        return null;
      })();
      if (answer !== null) {
        calls.push({ method, params });
        return answer;
      }
    }
    return inner(method, params);
  };
  transport.calls = calls;
  transport.state = state;
  transport.tokenBalances = tokenBalances;
  return transport;
}

/** The permit inside an RPC operation's paymasterData, decoded with ethers. */
function permitOf(rpcOp) {
  const bytes = ethers.getBytes(rpcOp.paymasterData);
  if (bytes.length < 53 || bytes[0] !== 0) return null;
  return {
    token: ethers.getAddress(ethers.hexlify(bytes.slice(1, 21))),
    amount: BigInt(ethers.hexlify(bytes.slice(21, 53))),
    signature: ethers.hexlify(bytes.slice(53)),
  };
}

/** True when Kernel's ERC-1271 (emulated) accepts `signature` for the permit of `amount`. */
function permitAccepted({ account, amount, nonce, signature, deadline = ethers.MaxUint256, spender = PAYMASTER }) {
  const digest = ethers.TypedDataEncoder.hash(USDC_DOMAIN, PERMIT_TYPES, {
    owner: account,
    spender,
    value: amount,
    nonce,
    deadline,
  });
  const result = emulateKernelIsValidSignature({
    account,
    owner: OWNER_0,
    chainId: CHAIN_ID,
    input: isValidSigIface.encodeFunctionData('isValidSignature', [digest, signature]),
  });
  return result.startsWith('0x1626ba7e');
}

/**
 * Fake bundler: emulates what a real bundler's simulation of Circle's
 * paymaster needs from the stub (a permit the account's ERC-1271 accepts,
 * and a USDC balance covering the permitted prefund), returns a fixed gas
 * estimate, records the submitted operation.
 */
function tgBundler(node, { estimate, floor = null, receipt = null } = {}) {
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x14a34';
    if (method === 'rundler_maxPriorityFeePerGas') throw new Error('RPC error -32601: method not found');
    if (method === 'pimlico_getUserOperationGasPrice') {
      if (floor === null) throw new Error('RPC error -32601: method not found');
      return { standard: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x' + floor.toString(16) } };
    }
    if (method === 'eth_estimateUserOperationGas') {
      const op = params[0];
      transport.estimated.push(op);
      if (op.paymaster) {
        const permit = permitOf(op);
        const ok =
          permit &&
          same(permit.token, USDC) &&
          permitAccepted({ account: op.sender, amount: permit.amount, nonce: node.state.permitNonce, signature: permit.signature });
        if (!ok) throw new Error('RPC error -32500: AA33 reverted: ERC20: transfer amount exceeds allowance');
        const held = node.tokenBalances[`${USDC.toLowerCase()}|${op.sender.toLowerCase()}`] ?? 0n;
        if (held < permit.amount) throw new Error('RPC error -32500: AA33 reverted: ERC20: transfer amount exceeds balance');
      }
      return estimate ?? {
        callGasLimit: '0xc350', // 50,000
        verificationGasLimit: '0x493e0', // 300,000
        preVerificationGas: '0xea60', // 60,000
        paymasterVerificationGasLimit: '0x13880', // 80,000
      };
    }
    if (method === 'eth_sendUserOperation') {
      transport.sent.push(params[0]);
      return USEROP_HASH;
    }
    if (method === 'eth_getUserOperationReceipt') return receipt;
    throw new Error(`tg bundler: unexpected method ${method}`);
  };
  transport.calls = calls;
  transport.estimated = [];
  transport.sent = [];
  return transport;
}

function kernelBundle({ node = tgNode(), bundler = null, chainId = CHAIN_ID, accountType = 'kernel-v3.3', paymaster } = {}) {
  const b = bundler ?? tgBundler(node);
  const bundle = createAaClient({
    nodeUrl: NODE_URL,
    bundlerUrl: BUNDLER_URL,
    factory: accountType === 'simple' ? '0x' + '55'.repeat(20) : KERNEL_V3_3.factory,
    chainId,
    accountIndex: 0,
    accountType,
    ...(paymaster ? { paymaster } : {}),
    transportFor: (url) => (url.includes('bundler') ? b : node),
  });
  return { bundle, node, bundler: b };
}

/** The paymaster's prefund formula (FeeLib + EntryPoint v0.7), written out independently. */
function expectedCharge({ gas, maxFee, price = PRICE, extra = 35_000n, spread = 0n }) {
  const prefund = gas * maxFee;
  const base = ((extra * maxFee + prefund) * price) / 10n ** 18n + 1n;
  return { prefund, total: base + (base * spread) / 10_000n };
}
const CEILING_GAS = 1_500_000n + 200_000n + 35_000n;
const MAX_FEE = 5_000_000n * 2n + 1_000_000n; // baseFee * 2 + priority (NodeClient.suggestFees)

function configFor(chain, overrides = {}) {
  return {
    bundlerUrl: BUNDLER_URL,
    bundlerVerifiedAt: '2026-10-04T00:00:00.000Z',
    bundlerChainIdVerified: chain.split(':')[1],
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation,
    kernelMetaFactory: KERNEL_V3_3.metaFactory,
    kernelValidator: KERNEL_V3_3.ecdsaValidator,
    kernelAccountId: 'kernel.advanced.v0.3.3',
    factoryVerifiedAt: '2026-10-04T00:00:00.000Z',
    paymasterUrl: null,
    paymasterContext: null,
    paymasterVerifiedAt: null,
    bundlerUrlIgnoredReason: null,
    paymasterUrlIgnoredReason: null,
    eip7702Owners: [],
    recoveredAccounts: [],
    chain,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: pinned constants and where the choice is offered');
// ---------------------------------------------------------------------------
{
  const engineSrc = readFileSync(new URL('../../packages/chains-evm/src/token-paymaster.ts', import.meta.url), 'utf8');
  check('the worst-case ceiling equals the engine stub default (estimationGasCeiling ?? 1_500_000n)',
    TOKEN_GAS_ESTIMATION_CEILING === 1_500_000n && engineSrc.includes('config.estimationGasCeiling ?? 1_500_000n'));
  const smokeSrc = readFileSync(new URL('../../scripts/testnet/token-gas-smoke.mjs', import.meta.url), 'utf8');
  check('the padding equals the live-proven smoke configuration',
    smokeSrc.includes('gasPaddingPct: { verification: 110, call: 130, preVerification: 105 }') &&
      TOKEN_GAS_PADDING_PCT.verification === 110 && TOKEN_GAS_PADDING_PCT.call === 130 && TOKEN_GAS_PADDING_PCT.preVerification === 105);
  check('only Base Sepolia has a verified paymaster (Circle v0.7 testnet address, USDC 0x036C…CF7e)',
    tokenGasPaymasterFor(BASE)?.paymaster === '0x31BE08D380A21fc740883c0BC434FcFc88740b58' &&
      tokenGasPaymasterFor(BASE)?.token === '0x036CbD53842c5426634e7929541eC2318f3dCF7e' &&
      tokenGasPaymasterFor(SEPOLIA) === null && tokenGasPaymasterFor(MAINNET) === null && tokenGasPaymasterFor('eip155:8453') === null && tokenGasPaymasterFor('bip122:x') === null);
  check('the fee token is the Base Sepolia USDC the token list offers (tokens.ts known tokens)',
    knownTokensForChain(BASE).some((t) => t.symbol === 'USDC' && same(t.assetId.reference, USDC) && t.decimals === 6));
  check('readiness: token-gas is a test-network-only, enforced feature, allowed on Base Sepolia, refused on mainnet',
    featureReadiness('token-gas').status === 'testnet-only' && featureReadiness('token-gas').enforced &&
      isFeatureAllowed('token-gas', BASE) && !isFeatureAllowed('token-gas', MAINNET) && !isFeatureAllowed('token-gas', 'eip155:8453'));

  const offer = (chain, cfg, extra = {}) => tokenGasOffer({ chainCaip2: chain, config: cfg, owner: OWNER_0, passkeySigner: false, ...extra });
  const avail = offer(BASE, configFor(BASE));
  check('Base Sepolia + Kernel v3.3 at its own address: available', avail.kind === 'available' && avail.paymaster === PAYMASTER && same(avail.token, USDC));
  const sep = offer(SEPOLIA, configFor(SEPOLIA));
  check('Ethereum Sepolia: hidden with the honest sentence (names the Circle networks and why Sepolia lacks it)',
    sep.kind === 'unavailable' && sep.reason === tokenGasNotOnNetworkSentence(SEPOLIA) &&
      sep.reason ===
        'Paying the network fee in USDC is offered only on Base Sepolia and Arbitrum Sepolia, where Circle’s token paymaster for EntryPoint v0.7 has been checked on-chain. It is not available on Ethereum Sepolia. On Ethereum Sepolia the same paymaster address does not serve EntryPoint v0.7 (its entryPoint() call reverts and it holds no deposit there).',
    sep.reason);
  check('mainnet: not offered (smart accounts themselves are test-network-only there)', offer(MAINNET, configFor(MAINNET)).kind === 'unavailable');
  check('the sentence names the active network and adds the Sepolia clause only there',
    tokenGasNotOnNetworkSentence(MAINNET).endsWith('It is not available on Ethereum.') && !tokenGasNotOnNetworkSentence(MAINNET).includes('Ethereum Sepolia the same'),
    tokenGasNotOnNetworkSentence(MAINNET));
  check('…and on another network it also names the ERC-7677 network (the Send screen offers it there)',
    tokenGasNotOnNetworkSentence(MAINNET) === 'Paying the network fee in USDC is offered only on Base Sepolia and Arbitrum Sepolia, where Circle’s token paymaster for EntryPoint v0.7 has been checked on-chain, and on Ethereum Sepolia through Pimlico’s token paymaster (reached through the saved bundler). It is not available on Ethereum.',
    tokenGasNotOnNetworkSentence(MAINNET));
  check('no smart-account configuration: not offered', offer(BASE, null).reason === TOKEN_GAS_NOT_CONFIGURED_NOTE);
  check('SimpleAccount: not offered (no ERC-1271)', offer(BASE, configFor(BASE, { accountType: 'simple' })).reason === TOKEN_GAS_SIMPLE_ACCOUNT_NOTE);
  check('EIP-7702-upgraded owner: not offered (unverified path)', offer(BASE, configFor(BASE, { eip7702Owners: [OWNER_0] })).reason === TOKEN_GAS_7702_NOTE);
  check('…but another owner on the same chain still gets it', tokenGasOffer({ chainCaip2: BASE, config: configFor(BASE, { eip7702Owners: [owner1.address] }), owner: OWNER_0, passkeySigner: false }).kind === 'available');
  check('passkey signer on: not offered', offer(BASE, configFor(BASE), { passkeySigner: true }).reason === TOKEN_GAS_PASSKEY_NOTE);
  check('a sponsoring ERC-7677 paymaster is configured: not offered (gas is already free)', offer(BASE, configFor(BASE, { paymasterUrl: 'https://pm.example' })).reason === TOKEN_GAS_SPONSORED_NOTE);
  check('a recovered Kernel account attached to the owner: offered (same ERC-1271 envelope)',
    offer(BASE, configFor(BASE, { recoveredAccounts: [{ owner: OWNER_0, account: '0x' + '12'.repeat(20), attachedAt: 'x' }] })).kind === 'available');
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: on-chain paymaster check (and its cache)');
// ---------------------------------------------------------------------------
{
  forgetTokenGasChecks();
  let t = 1_000_000;
  const now = () => t;
  const node = tgNode();
  const ok = await checkTokenGasPaymaster(NODE_URL, BASE, { transportFor: () => node, now });
  check('a healthy paymaster passes and carries the state', ok.ok === true && ok.state.nativeTokenPrice === PRICE && ok.state.feeSpreadBips === 0n && same(ok.state.oracle, ORACLE));
  const n1 = node.calls.length;
  await checkTokenGasPaymaster(NODE_URL, BASE, { transportFor: () => node, now });
  check('a second check within the TTL makes no request', node.calls.length === n1);
  t += TOKEN_GAS_CHECK_TTL_MS + 1;
  await checkTokenGasPaymaster(NODE_URL, BASE, { transportFor: () => node, now });
  check('after the TTL it reads the chain again', node.calls.length > n1);
  const cases = [
    ['paused', { paused: true }, 'The paymaster is paused by its operator.'],
    ['another EntryPoint', { entryPoint: '0x' + '11'.repeat(20) }, 'The paymaster serves EntryPoint'],
    ['another token', { token: '0x' + '22'.repeat(20) }, 'The paymaster accepts only'],
    ['not staked', { staked: false }, 'not staked'],
    ['no deposit', { deposit: 0n }, 'no EntryPoint deposit'],
  ];
  for (const [label, o, text] of cases) {
    forgetTokenGasChecks();
    const r = await checkTokenGasPaymaster(NODE_URL, BASE, { transportFor: () => tgNode(o), now });
    check(`${label}: the choice is hidden with the engine's reason`, r.ok === false && r.reason.startsWith(TOKEN_GAS_UNAVAILABLE_TITLE) && r.reason.includes(text), r.reason);
  }
  forgetTokenGasChecks();
  const wrong = await checkTokenGasPaymaster(NODE_URL, BASE, { transportFor: () => tgNode({ chainIdHex: '0xaa36a7' }), now });
  check('an endpoint for another chain is refused (not read)', wrong.ok === false && wrong.reason.includes('11155111'));
  forgetTokenGasChecks();
  let failing = true;
  const flaky = tgNode();
  const flakyTransport = async (m, p) => {
    if (failing && m === 'eth_chainId') throw new TypeError('Network request failed');
    return flaky(m, p);
  };
  const down = await checkTokenGasPaymaster(NODE_URL, BASE, { transportFor: () => flakyTransport, now });
  failing = false;
  const back = await checkTokenGasPaymaster(NODE_URL, BASE, { transportFor: () => flakyTransport, now });
  check('a failed read is reported and not cached (the next check succeeds)', down.ok === false && down.reason.includes('could not be checked') && back.ok === true);
  check('Ethereum Sepolia is never read', (await checkTokenGasPaymaster(NODE_URL, SEPOLIA, { transportFor: () => { throw new Error('no request'); }, now })).ok === false);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: refusals before any request');
// ---------------------------------------------------------------------------
{
  const n = tgNode();
  const main = kernelBundle({ node: n, chainId: 1n });
  const e1 = await rejection(() => prepareAaTokenGasSend(main.bundle, OWNER_0, RECIPIENT, 1n));
  check('mainnet: FeatureNotAllowedError (readiness) with no request', e1 instanceof FeatureNotAllowedError && e1.featureId === 'token-gas' && n.calls.length === 0, e1?.message);
  const sepBundle = kernelBundle({ node: n, chainId: 11155111n });
  const e2 = await rejection(() => prepareAaTokenGasSend(sepBundle.bundle, OWNER_0, RECIPIENT, 1n));
  check('Ethereum Sepolia: TokenGasUnavailableError (no verified paymaster) with no request',
    e2 instanceof TokenGasUnavailableError && e2.message === tokenGasNotOnNetworkSentence(SEPOLIA) && n.calls.length === 0, e2?.message);
  for (const [label, opts] of [
    ['SimpleAccount', { accountType: 'simple' }],
    ['EIP-7702 account', { accountType: 'kernel-7702' }],
    ['sponsored bundle', { paymaster: { url: 'https://pm.example', contextJson: null } }],
  ]) {
    const b = kernelBundle({ node: n, ...opts });
    const e = await rejection(() => prepareAaTokenGasSend(b.bundle, OWNER_0, RECIPIENT, 1n));
    check(`${label}: refused with the account sentence, no request`, e?.message === TOKEN_GAS_ACCOUNT_REFUSAL && n.calls.length === 0, e?.message);
  }
  const wrongDomain = kernelBundle({ node: tgNode({ domainOk: false }) });
  const e3 = await rejection(() => prepareAaTokenGasSend(wrongDomain.bundle, OWNER_0, RECIPIENT, 1n));
  check('a USDC DOMAIN_SEPARATOR that does not match its EIP-712 domain is refused before the gate', e3?.message.includes('refusing to sign a permit'), e3?.message);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: the quote (worst case recomputed independently)');
// ---------------------------------------------------------------------------
let nativeQuote;
{
  const { bundle, node, bundler } = kernelBundle({ node: tgNode({ usdc: 1_000_000n }) });
  nativeQuote = await prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 12_345n);
  const tg = nativeQuote.tokenGas;
  const expected = expectedCharge({ gas: CEILING_GAS, maxFee: MAX_FEE });
  check('worst case = ((35,000 + 1,735,000 gas) × maxFee × price / 1e18 + 1) × (1 + spread)',
    tg.maxTokenCharge === expected.total && tg.requiredPrefundWei === expected.prefund, `${tg.maxTokenCharge} vs ${expected.total}`);
  check('the quote carries the paymaster, token, price, spread, extra gas, oracle and limits it was computed with',
    tg.paymaster === PAYMASTER && same(tg.token, USDC) && tg.decimals === 6 && tg.nativeTokenPrice === PRICE && tg.feeSpreadBips === 0n &&
      tg.additionalGasCharge === 35_000n && same(tg.oracle, ORACLE) && tg.estimationGasCeiling === 1_500_000n &&
      tg.paymasterVerificationGasLimit === 200_000n && tg.paymasterPostOpGasLimit === 35_000n && tg.tokenBalance === 1_000_000n);
  check('no ETH fee: fee 0, total = amount, gas fields 0 (not estimated before the gate), not sponsored',
    nativeQuote.fee === 0n && nativeQuote.total === 12_345n && nativeQuote.amount === 12_345n && nativeQuote.callGasLimit === 0n &&
      nativeQuote.verificationGasLimit === 0n && nativeQuote.preVerificationGas === 0n && nativeQuote.sponsored === false);
  check('quote fees are the node suggestion (no bundler floor served)', nativeQuote.maxFeePerGas === MAX_FEE && nativeQuote.maxPriorityFeePerGas === 1_000_000n);
  check('the quote made no bundler estimate and signed nothing (only node reads and the fee-floor probe)',
    bundler.estimated.length === 0 && bundler.sent.length === 0 &&
      bundler.calls.every((c) => ['rundler_maxPriorityFeePerGas', 'pimlico_getUserOperationGasPrice'].includes(c.method)) &&
      node.calls.every((c) => !String(c.method).includes('UserOperation')));
  check('sender = the Kernel counterfactual, still undeployed', nativeQuote.sender === KERNEL_ACCOUNT_0 && nativeQuote.deployed === false);

  // Spread and the bundler's priority floor change the figure exactly.
  const n2 = tgNode({ usdc: 5_000_000n, spread: 1_000n });
  const b2 = tgBundler(n2, { floor: 100_000_000n });
  const q2 = await prepareAaTokenGasSend(kernelBundle({ node: n2, bundler: b2 }).bundle, OWNER_0, RECIPIENT, 1n);
  // The quote prices at the floor plus aa.ts AA_FEE_FLOOR_HEADROOM_PERCENT
  // (100 % since 2026-10-04): 0.1 gwei → 0.2 gwei.
  const fee2 = MAX_FEE + (200_000_000n - 1_000_000n);
  check('with a 10% spread and a 0.1 gwei bundler floor (+100% headroom) the worst case follows exactly',
    q2.maxFeePerGas === fee2 && q2.tokenGas.maxTokenCharge === expectedCharge({ gas: CEILING_GAS, maxFee: fee2, spread: 1_000n }).total,
    `${q2.tokenGas.maxTokenCharge}`);
  // Control (mutation guard): a different ceiling would give a different figure.
  check('control: a 1,400,000-gas ceiling would not match (the figure is ceiling-sensitive)',
    expectedCharge({ gas: CEILING_GAS - 100_000n, maxFee: MAX_FEE }).total !== tg.maxTokenCharge);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: confirm-screen sentences');
// ---------------------------------------------------------------------------
{
  const max = fmt6(nativeQuote.tokenGas.maxTokenCharge);
  check('fee sentence', tokenGasFeeSentence(max) === `Network fee paid in USDC: up to ${max} USDC; the unused part is refunded in the same transaction; no ETH is needed for the fee.`);
  check('grant sentence', tokenGasGrantSentence(max) === `A one-time permit letting Circle’s paymaster take at most ${max} USDC. The permit is used up by this operation, so normally nothing stays approved.`);
  check('rate sentence names the on-chain oracle', tokenGasRateSentence(PRICE, 6, 'test ETH') === '1 test ETH = 3000 USDC, from the paymaster’s on-chain oracle.');
  check('Base Sepolia says the test oracle is a fixed price; other chains say nothing',
    tokenGasOracleNote(BASE) === TOKEN_GAS_FIXED_ORACLE_NOTE && TOKEN_GAS_FIXED_ORACLE_NOTE === 'On Base Sepolia the paymaster’s test oracle returns a fixed price; it is not a market rate.' && tokenGasOracleNote(SEPOLIA) === null);
  check('spread text (exact, from chain)', tokenGasSpreadText(0n) === '0% (0 basis points), read from the paymaster' && tokenGasSpreadText(1_000n) === '10% (1000 basis points), read from the paymaster' && tokenGasSpreadText(5n) === '0.05% (5 basis points), read from the paymaster');
  check('the estimate-after-approval sentence', TOKEN_GAS_ESTIMATE_AFTER_APPROVAL === 'The bundler’s gas estimate runs after you approve, because Circle’s paymaster needs a permit signed by your smart account first. If the estimate fails, nothing is sent.');
  check('charged sentence', tokenGasChargedSentence('0.005392', '0.015291') === 'Network fee charged: 0.005392 USDC (up to 0.015291 USDC was permitted; the rest was refunded in the same transaction).');
  const send = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  // Phase 14 integration: the confirm renders tokenGasConfirmLines (both
  // sources); the Circle strings it yields are pinned byte for byte against
  // these functions in the "SendScreen wiring" section at the end.
  check('SendScreen shows the fee, grant, rate, oracle note, spread, paymaster and estimate sentences on the USDC-fee confirm',
    ['{tgLines.feeSentence}', '{tgLines.grantSentence}', 'value={tgLines.rateValue} sub={tgLines.rateNote}', 'sub={tgLines.spreadNote}', 'label={tgLines.paymasterLabel}', '{tgLines.estimateSentence}', '{tgLines.worstCaseHint}'].every((s) => send.includes(s)));
  check('…and keeps "Bundler gas estimate passed" for every other smart-account quote', send.includes('Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).'));
  check('the choice is a switch that defaults to ETH (feeInUsdc starts false)', send.includes('useState(false);\n  // The Max record for the USDC-fee path') || /const \[feeInUsdc, setFeeInUsdc\] = useState\(false\)/.test(send));
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: funding refusals and Max');
// ---------------------------------------------------------------------------
{
  const worst = nativeQuote.tokenGas.maxTokenCharge;
  // Native.
  const poorUsdc = kernelBundle({ node: tgNode({ usdc: worst - 1n }) });
  const e1 = await rejection(() => prepareAaTokenGasSend(poorUsdc.bundle, OWNER_0, RECIPIENT, 1n));
  check('USDC one unit below the worst case: AaFundingError naming the smart account and both USDC figures',
    e1 instanceof AaFundingError && e1.message.includes(`Fund the smart account address ${KERNEL_ACCOUNT_0} with USDC`) &&
      e1.message.includes(`holds ${fmt6(worst - 1n)} USDC`) && e1.message.includes(`up to ${fmt6(worst)} USDC`), e1?.message);
  const exact = await prepareAaTokenGasSend(kernelBundle({ node: tgNode({ usdc: worst }) }).bundle, OWNER_0, RECIPIENT, 1n);
  check('USDC exactly the worst case: accepted (boundary)', exact.tokenGas.maxTokenCharge === worst);
  const e2 = await rejection(() => prepareAaTokenGasSend(kernelBundle({ node: tgNode({ eth: 100n }) }).bundle, OWNER_0, RECIPIENT, 101n));
  check('native amount above the ETH balance is refused (and says the fee needs no ETH)', e2 instanceof AaFundingError && e2.message.includes('no ETH is needed for it'), e2?.message);
  const full = await prepareAaTokenGasSend(kernelBundle({ node: tgNode({ eth: 100n }) }).bundle, OWNER_0, RECIPIENT, 100n);
  check('native amount equal to the whole ETH balance is accepted (no ETH fee)', full.amount === 100n && full.total === 100n);
  check('native Max = the full ETH balance', (await maxAaTokenGasSend(kernelBundle({ node: tgNode({ eth: 777n }) }).bundle, OWNER_0)) === 777n);
  const e3 = await rejection(() => maxAaTokenGasSend(poorUsdc.bundle, OWNER_0));
  check('native Max refuses when the USDC cannot cover the fee', e3 instanceof AaFundingError);
  const trimmed = await prepareAaTokenGasSend(kernelBundle({ node: tgNode({ eth: 500n }) }).bundle, OWNER_0, RECIPIENT, 600n, { fromMax: true });
  check('native fromMax above a balance that fell is lowered to the balance (never raised)', trimmed.amount === 500n && trimmed.maxAdjustment?.requested === 600n);

  // USDC send: amount + fee from the same balance.
  const usdcTarget = { contract: USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, chainCaip2: BASE };
  const bal = 2_000_000n;
  const uBundle = () => kernelBundle({ node: tgNode({ usdc: bal }) }).bundle;
  const max = await maxAaTokenGasErc20Send(uBundle(), OWNER_0, usdcTarget);
  check('USDC Max = balance − worst-case fee', max === bal - worst, `${max}`);
  const atMax = await prepareAaTokenGasErc20Send(uBundle(), OWNER_0, { ...usdcTarget, amount: max });
  check('USDC Max quotes (amount + worst case = balance exactly)', atMax.token.amount === max && atMax.tokenSpend.amount === max && atMax.tokenGas.maxTokenCharge + max === bal);
  const e4 = await rejection(() => prepareAaTokenGasErc20Send(uBundle(), OWNER_0, { ...usdcTarget, amount: max + 1n }));
  check('one unit more is refused with "plus a network fee"', e4 instanceof AaFundingError && e4.message.includes(`needs ${fmt6(max + 1n)} USDC plus a network fee of up to ${fmt6(worst)} USDC`), e4?.message);
  const low = await prepareAaTokenGasErc20Send(uBundle(), OWNER_0, { ...usdcTarget, amount: max + 7n }, { fromMax: true });
  check('USDC fromMax lowers to balance − worst case in one exact step', low.token.amount === max && low.maxAdjustment?.requested === max + 7n && low.calls.length === 1);
  const transfer = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', low.calls[0].data);
  check('…and the transfer calldata carries the lowered amount (ethers decode)', same(transfer[0], RECIPIENT) && transfer[1] === max && same(low.calls[0].to, USDC) && low.calls[0].value === 0n);
  check('a tiny USDC balance gives Max 0', (await maxAaTokenGasErc20Send(kernelBundle({ node: tgNode({ usdc: worst }) }).bundle, OWNER_0, usdcTarget)) === 0n);

  // Another token (EURC): its own balance for the amount, USDC for the fee.
  const eurcTarget = { contract: EURC, recipient: RECIPIENT, symbol: 'EURC', decimals: 6, chainCaip2: BASE };
  check('EURC Max = the full EURC balance', (await maxAaTokenGasErc20Send(kernelBundle({ node: tgNode({ usdc: worst, eurc: 4_321n }) }).bundle, OWNER_0, eurcTarget)) === 4_321n);
  const e5 = await rejection(() => maxAaTokenGasErc20Send(kernelBundle({ node: tgNode({ usdc: worst - 1n, eurc: 4_321n }) }).bundle, OWNER_0, eurcTarget));
  check('EURC Max refuses when USDC cannot cover the fee', e5 instanceof AaFundingError);
  const e6 = await rejection(() => prepareAaTokenGasErc20Send(kernelBundle({ node: tgNode({ usdc: worst, eurc: 10n }) }).bundle, OWNER_0, { ...eurcTarget, amount: 11n }));
  check('EURC amount above its balance is refused', e6?.message.includes('exceeds the token balance of 10 base units'), e6?.message);
  const eq = await prepareAaTokenGasErc20Send(kernelBundle({ node: tgNode({ usdc: worst, eurc: 10n }) }).bundle, OWNER_0, { ...eurcTarget, amount: 10n });
  check('EURC send quote: EURC balance on tokenSpend, USDC balance on tokenGas', eq.tokenSpend.balance === 10n && eq.tokenGas.tokenBalance === worst);
  const e7 = await rejection(() => prepareAaTokenGasErc20Send(uBundle(), OWNER_0, { ...usdcTarget, chainCaip2: SEPOLIA, amount: 1n }));
  check('a token from another chain is refused before any request', e7?.message.includes('belongs to eip155:11155111'), e7?.message);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: spending limits (decision: the USDC fee is not counted)');
// ---------------------------------------------------------------------------
{
  const input = spendingInputForQuote(nativeQuote, OWNER_0);
  check('the quote reports no ETH fee to the limits and its calls unchanged', input.fee === 0n && input.spender === KERNEL_ACCOUNT_0 && input.calls === nativeQuote.calls);
  let refused = null;
  try {
    validatePolicyList({ chain: BASE, owner: OWNER_0 }, [{ id: 'p', token: USDC, symbol: 'USDC', decimals: 6, cap: 1n, windowSeconds: 3600, allowOverride: false, countFees: true }], [USDC]);
  } catch (e) {
    refused = e;
  }
  check('…because a USDC limit cannot count fees at all (countFees is native-only)', refused?.message === 'Network fees can only be counted in a limit on the network’s own coin.', refused?.message);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: quote -> gate -> estimate -> sign -> send');
// ---------------------------------------------------------------------------
{
  const node = tgNode({ usdc: 2_000_000n, eth: 0n });
  const bundler = tgBundler(node);
  const { bundle } = kernelBundle({ node, bundler });
  const quote = await prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n);
  const shown = quote.tokenGas.maxTokenCharge;
  check('quoting signed nothing and estimated nothing', bundler.estimated.length === 0 && bundler.sent.length === 0);
  const { userOpHash } = await sendAa(bundle, owner, quote);
  check('sendAa returns the bundler userOpHash', userOpHash === USEROP_HASH);
  check('exactly one estimate and one submission', bundler.estimated.length === 1 && bundler.sent.length === 1);
  const stub = bundler.estimated[0];
  const stubPermit = permitOf(stub);
  check('the estimation op names Circle’s paymaster with the stub limits (200,000 / 35,000)',
    same(stub.paymaster, PAYMASTER) && BigInt(stub.paymasterVerificationGasLimit) === 200_000n && BigInt(stub.paymasterPostOpGasLimit) === 35_000n);
  check('the stub permit is for EXACTLY the displayed worst case', stubPermit.amount === shown && same(stubPermit.token, USDC), `${stubPermit?.amount} vs ${shown}`);
  check('the stub permit is the account’s ERC-1271 signature (Kernel envelope; owner recovered by ethers) with deadline = max uint256',
    permitAccepted({ account: KERNEL_ACCOUNT_0, amount: stubPermit.amount, nonce: 0n, signature: stubPermit.signature }));
  check('control: the same signature does not validate for another amount, spender or deadline',
    !permitAccepted({ account: KERNEL_ACCOUNT_0, amount: stubPermit.amount + 1n, nonce: 0n, signature: stubPermit.signature }) &&
      !permitAccepted({ account: KERNEL_ACCOUNT_0, amount: stubPermit.amount, nonce: 0n, signature: stubPermit.signature, spender: RECIPIENT }) &&
      !permitAccepted({ account: KERNEL_ACCOUNT_0, amount: stubPermit.amount, nonce: 0n, signature: stubPermit.signature, deadline: 1n }));

  const op = bundler.sent[0];
  const finalPermit = permitOf(op);
  const padded = { call: (50_000n * 130n) / 100n, verification: (300_000n * 110n) / 100n, pre: (60_000n * 105n) / 100n, pmv: (80_000n * 110n) / 100n };
  check('the submitted limits are the estimate with the live-proven padding (call 130%, verification 110%, preVerification 105%, paymaster verification 110%)',
    BigInt(op.callGasLimit) === padded.call && BigInt(op.verificationGasLimit) === padded.verification &&
      BigInt(op.preVerificationGas) === padded.pre && BigInt(op.paymasterVerificationGasLimit) === padded.pmv && BigInt(op.paymasterPostOpGasLimit) === 35_000n);
  const finalExpected = expectedCharge({ gas: padded.call + padded.verification + padded.pre + padded.pmv + 35_000n, maxFee: MAX_FEE });
  check('the final permit is the post-estimate worst case (recomputed independently)', finalPermit.amount === finalExpected.total, `${finalPermit.amount} vs ${finalExpected.total}`);
  check('…and is never above what the user saw', finalPermit.amount <= shown && finalPermit.amount > 0n);
  check('the final permit validates through the Kernel ERC-1271 envelope (same nonce as the stub: at most one can take effect)',
    permitAccepted({ account: KERNEL_ACCOUNT_0, amount: finalPermit.amount, nonce: 0n, signature: finalPermit.signature }));
  check('the operation uses the quote’s fees', BigInt(op.maxFeePerGas) === quote.maxFeePerGas && BigInt(op.maxPriorityFeePerGas) === quote.maxPriorityFeePerGas);
  check('the counterfactual account deploys in the same operation (meta factory)', same(op.factory, KERNEL_V3_3.metaFactory));
  const exec = decodeKernelExecute(op.callData);
  check('callData = the reviewed call (ethers decode)', exec.calls.length === 1 && same(exec.calls[0].to, RECIPIENT) && exec.calls[0].value === 0n);
  const full = {
    ...fromRpcOp(op),
    paymaster: op.paymaster,
    paymasterVerificationGasLimit: BigInt(op.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit),
    paymasterData: toBytes(op.paymasterData),
  };
  const hash = getUserOpHash(full, ENTRYPOINT_V07, CHAIN_ID);
  check('the userOp signature (covering paymasterAndData) recovers to the owner (ethers)', ethers.verifyMessage(hash, op.signature) === OWNER_0);
  const nodeSigning = node.calls.filter((c) => c.method === 'eth_call' && same(c.params[0].to, USDC) && c.params[0].data.startsWith(sel('nonces(address)')));
  check('the permit nonce was read for each permit (stub and final) plus once at quote time', nodeSigning.length === 3, `${nodeSigning.length}`);

  // A deployed account and a USDC send (amount + fee from one balance).
  const n2 = tgNode({ usdc: 2_000_000n, deployed: true });
  const b2 = tgBundler(n2);
  const k2 = kernelBundle({ node: n2, bundler: b2 });
  const q2 = await prepareAaTokenGasErc20Send(k2.bundle, OWNER_0, { contract: USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, chainCaip2: BASE, amount: 1_000_000n });
  await sendAa(k2.bundle, owner, q2);
  const op2 = b2.sent[0];
  check('deployed account: no factory, transfer(recipient, 1 USDC) from the account',
    op2.factory === undefined && (() => {
      const e = decodeKernelExecute(op2.callData);
      const t = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', e.calls[0].data);
      return same(e.calls[0].to, USDC) && same(t[0], RECIPIENT) && t[1] === 1_000_000n;
    })());
  check('deployed account: the final permit validates and stays ≤ the displayed worst case',
    permitAccepted({ account: KERNEL_ACCOUNT_0, amount: permitOf(op2).amount, nonce: 0n, signature: permitOf(op2).signature }) && permitOf(op2).amount <= q2.tokenGas.maxTokenCharge);

  // The quote is bound to its signer.
  const e = await rejection(() => sendAa(k2.bundle, owner1, q2));
  check('a signer whose smart account is not the quoted sender is refused before signing', e?.message.includes('Nothing was signed') && b2.sent.length === 1);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: the cap (the charge can never exceed what the user saw)');
// ---------------------------------------------------------------------------
{
  // The oracle price doubles between the quote and the send.
  const node = tgNode({ usdc: 5_000_000n });
  const bundler = tgBundler(node);
  const { bundle } = kernelBundle({ node, bundler });
  const quote = await prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 1n);
  node.state.price = PRICE * 2n;
  const e1 = await rejection(() => sendAa(bundle, owner, quote));
  check('price rise: TokenGasChargeAboveLimitError before ANY permit is signed (no estimate, no submission)',
    e1 instanceof TokenGasChargeAboveLimitError && e1.limit === quote.tokenGas.maxTokenCharge && e1.required > e1.limit &&
      bundler.estimated.length === 0 && bundler.sent.length === 0, e1?.message);
  const d1 = describeTokenGasError(e1, quote.tokenGas);
  check('…described in plain words, telling the user to review again',
    d1?.title === TOKEN_GAS_FEE_ROSE_TITLE && d1.detail === tokenGasAboveLimitSentence(fmt6(e1.required), fmt6(e1.limit)) &&
      d1.detail.endsWith('Nothing was sent. Review the send again to see the new fee.'), d1?.detail);

  // The bundler's estimate is far above the ceiling: the final data is refused.
  const n2 = tgNode({ usdc: 5_000_000n });
  const b2 = tgBundler(n2, { estimate: { callGasLimit: '0x1e8480', verificationGasLimit: '0x1e8480', preVerificationGas: '0xea60', paymasterVerificationGasLimit: '0x13880' } });
  const k2 = kernelBundle({ node: n2, bundler: b2 });
  const q2 = await prepareAaTokenGasSend(k2.bundle, OWNER_0, RECIPIENT, 1n);
  const e2 = await rejection(() => sendAa(k2.bundle, owner, q2));
  check('estimate above the ceiling: refused at the final paymaster data, nothing submitted',
    e2 instanceof TokenGasChargeAboveLimitError && e2.limit === q2.tokenGas.maxTokenCharge && b2.estimated.length === 1 && b2.sent.length === 0, e2?.message);
  const nonceReads = n2.calls.filter((c) => c.method === 'eth_call' && same(c.params[0].to, USDC) && c.params[0].data.startsWith(sel('nonces(address)'))).length;
  check('…by the engine’s own maxTokenCharge check, before the final permit is even built (permit nonce read only for the quote and the stub)',
    nonceReads === 2, `${nonceReads}`);

  // The bundler's fee floor moves between the quote and the send. The USDC
  // worst case is priced at the quote's fees (floor + 100 % headroom) and the
  // operation is signed with exactly those fees, so the permit cap and the
  // floor rule compose: a drift inside the headroom changes nothing, a
  // larger one is refused before ANY permit is signed.
  {
    const n3 = tgNode({ usdc: 5_000_000n });
    const inner = tgBundler(n3, { floor: 100_000_000n });
    let floorNow = 100_000_000n;
    const b3 = async (method, params) =>
      method === 'pimlico_getUserOperationGasPrice'
        ? { standard: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x' + floorNow.toString(16) } }
        : inner(method, params);
    b3.estimated = inner.estimated;
    b3.sent = inner.sent;
    const k3 = kernelBundle({ node: n3, bundler: b3 });
    const q3 = await prepareAaTokenGasSend(k3.bundle, OWNER_0, RECIPIENT, 1n);
    check('USDC fee quote: priority = floor + 100 % (0.2 gwei)', q3.maxPriorityFeePerGas === 200_000_000n);
    floorNow = 200_000_001n; // one wei above the quoted priority fee
    const e3 = await rejection(() => sendAa(k3.bundle, owner, q3));
    check('floor above the quoted priority at send: AaFeeRoseError before any permit (no estimate, no submission)',
      e3 instanceof AaFeeRoseError && inner.estimated.length === 0 && inner.sent.length === 0, e3?.message);
    const again = await rejection(() => sendAa(k3.bundle, owner, q3));
    check('…and the same quote is not sent again', again?.message === AA_QUOTE_ALREADY_USED && inner.sent.length === 0);
    floorNow = 108_000_000n; // +8 %, inside the headroom
    const q4 = await prepareAaTokenGasSend(k3.bundle, OWNER_0, RECIPIENT, 1n);
    check('re-quote at the risen floor: priority 0.216 gwei, worst case priced at it', q4.maxPriorityFeePerGas === 216_000_000n);
    floorNow = 216_000_000n; // +100 % since the re-quote: exactly the headroom
    await sendAa(k3.bundle, owner, q4);
    const op4 = inner.sent[0];
    check('a +100 % drift (exactly the headroom): sent with EXACTLY the quoted fees, final permit ≤ the displayed USDC worst case',
      inner.sent.length === 1 && BigInt(op4.maxPriorityFeePerGas) === q4.maxPriorityFeePerGas && BigInt(op4.maxFeePerGas) === q4.maxFeePerGas &&
        permitOf(op4).amount <= q4.tokenGas.maxTokenCharge);
  }

  // assertTokenGasPermit on its own.
  const tg = q2.tokenGas;
  const permit = (m = {}, d = {}) => ({
    domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC, ...d },
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: KERNEL_ACCOUNT_0, spender: PAYMASTER, value: tg.maxTokenCharge, nonce: 0n, deadline: (1n << 256n) - 1n, ...m },
    digest: new Uint8Array(32),
  });
  const expect = { account: KERNEL_ACCOUNT_0, tokenGas: tg, chainId: CHAIN_ID };
  let ok = true;
  try {
    assertTokenGasPermit(permit(), expect);
    assertTokenGasPermit(permit({ value: 1n }), expect);
  } catch {
    ok = false;
  }
  check('a permit at or below the displayed amount passes', ok);
  const refusedFor = (m, d) => {
    try {
      assertTokenGasPermit(permit(m, d), expect);
      return null;
    } catch (e) {
      return e;
    }
  };
  check('one unit above: TokenGasChargeAboveLimitError', refusedFor({ value: tg.maxTokenCharge + 1n }) instanceof TokenGasChargeAboveLimitError);
  for (const [label, m, d] of [
    ['another owner', { owner: RECIPIENT }],
    ['another spender', { spender: RECIPIENT }],
    ['another token contract', {}, { verifyingContract: EURC }],
    ['another chain', {}, { chainId: 11155111n }],
    ['a finite deadline', { deadline: 1_900_000_000n }],
  ]) {
    check(`${label}: refused before signing`, refusedFor(m, d)?.message.includes('does not match the reviewed send'));
  }
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: sendAa refusals for a USDC-fee quote');
// ---------------------------------------------------------------------------
{
  const quote = nativeQuote;
  for (const [label, opts] of [
    ['SimpleAccount bundle', { accountType: 'simple' }],
    ['sponsored bundle', { paymaster: { url: 'https://pm.example', contextJson: null } }],
  ]) {
    const { bundle, bundler } = kernelBundle(opts);
    const e = await rejection(() => sendAa(bundle, owner, quote));
    check(`${label}: refused with the account sentence, nothing estimated`, e?.message === TOKEN_GAS_ACCOUNT_REFUSAL && bundler.estimated.length === 0, e?.message);
  }
  const main = kernelBundle({ chainId: 1n });
  const e = await rejection(() => sendAa(main.bundle, owner, quote));
  check('mainnet bundle: FeatureNotAllowedError (token-gas)', e instanceof FeatureNotAllowedError && e.featureId === 'token-gas');
}

// Emulator-run findings 3, 4 and 5 (phase 13): the preview footnote, the
// fee copy on the Tokens and Settings screens, and the funding titles in
// USDC-fee mode.
console.log('check-token-gas: footnote, fee copy and funding titles');
{
  const worst = nativeQuote.tokenGas.maxTokenCharge;
  const tgNote = 'Simulated as a direct call from your smart account. The network fee is paid in USDC through ' +
    'Circle’s paymaster and is shown above; it is not part of this list.';
  check('USDC-fee quote: the preview footnote says the fee is paid in USDC through the paymaster and shown above',
    aaPreviewNote(nativeQuote) === tgNote && !/EntryPoint/.test(aaPreviewNote(nativeQuote)), aaPreviewNote(nativeQuote));
  const batchNote = aaPreviewNote({ ...nativeQuote, calls: [nativeQuote.calls[0], nativeQuote.calls[0]] });
  check('…and its batch form keeps the atomic-batch sentence', /one atomic operation/.test(batchNote) && /paid in USDC through Circle’s paymaster and is shown above/.test(batchNote));
  const { tokenGas: _omit, ...plain } = nativeQuote;
  check('control: an ETH-fee quote keeps the plain notes', aaPreviewNote(plain) === PREVIEW_AA_NOTE && aaPreviewNote({ ...plain, calls: [plain.calls[0], plain.calls[0]] }) === PREVIEW_AA_BATCH_NOTE);
  const sendSrc = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  check('SendScreen picks the footnote with aaPreviewNote(quote)', sendSrc.includes('note={aaPreviewNote(quote)}') && !sendSrc.includes('PREVIEW_AA_BATCH_NOTE : PREVIEW_AA_NOTE'));

  check('Tokens screen fee sentence on Base Sepolia names the USDC option without promising it',
    tokenSendFeeSentence(BASE) === 'The network fee for a token send is normally paid in test ETH, not in the token. On Base Sepolia, a smart-account send can pay it in USDC instead when the Send screen offers that choice.',
    tokenSendFeeSentence(BASE));
  // Phase 14 integration: the Send screen offers the ERC-7677 source on
  // Ethereum Sepolia, so the Tokens and Settings sentences name it too.
  check('…on Ethereum Sepolia the USDC sentence names the Send-screen choice (ERC-7677 source); on mainnet there is none',
    tokenSendFeeSentence(SEPOLIA) === 'The network fee for a token send is normally paid in test ETH, not in the token. On Ethereum Sepolia, a smart-account send can pay it in USDC instead when the Send screen offers that choice.' &&
      tokenSendFeeSentence(MAINNET) === 'The network fee for a token send is normally paid in ETH, not in the token.', tokenSendFeeSentence(SEPOLIA));
  check('Settings fee sentence covers every network',
    settingsTokensFeeSentence() === 'The network fee for a token send is normally paid in ETH (test ETH on test networks), not in the token; on Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia, a smart-account send can pay it in USDC instead when the Send screen offers that choice.',
    settingsTokensFeeSentence());
  const tokensSrc = readFileSync(new URL('../src/screens/TokensScreen.tsx', import.meta.url), 'utf8');
  const settingsSrc = readFileSync(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  check('the screens use the helpers and the old absolute wording is gone',
    tokensSrc.includes('{tokenSendFeeSentence(evmChain.caip2)}') && !tokensSrc.includes('the network fee for a token send is paid in') &&
      settingsSrc.includes('{settingsTokensFeeSentence()}') && !settingsSrc.includes('with the network fee paid in ETH'));

  // Funding titles with the USDC fee (Base Sepolia).
  const noEth = await rejection(() => prepareAaTokenGasSend(kernelBundle({ node: tgNode({ eth: 100n }) }).bundle, OWNER_0, RECIPIENT, 101n));
  check('native amount above the ETH balance (fee in USDC): "Not enough test ETH for this amount."',
    noEth instanceof AaFundingError && noEth.title === 'Not enough test ETH for this amount.', noEth?.title);
  const usdcTarget = { contract: USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, chainCaip2: BASE };
  const bal = 2_000_000n;
  const over = await rejection(() => prepareAaTokenGasErc20Send(kernelBundle({ node: tgNode({ usdc: bal }) }).bundle, OWNER_0, { ...usdcTarget, amount: bal - worst + 1n }));
  check('USDC amount + fee above a balance that covers the fee: "Not enough USDC for this amount plus the network fee."',
    over instanceof AaFundingError && over.title === 'Not enough USDC for this amount plus the network fee.' &&
      describeAaError(over, { accountType: 'kernel-v3.3', deployed: true })?.title === over.title, over?.title);
  const feeShort = await rejection(() => prepareAaTokenGasErc20Send(kernelBundle({ node: tgNode({ usdc: worst - 1n }) }).bundle, OWNER_0, { ...usdcTarget, amount: 1n }));
  check('USDC below the worst-case fee alone: the existing "needs funds first" title', feeShort instanceof AaFundingError && feeShort.title === AA_FUNDING_TITLE, feeShort?.title);
  const nativeFeeShort = await rejection(() => prepareAaTokenGasSend(kernelBundle({ node: tgNode({ usdc: worst - 1n }) }).bundle, OWNER_0, RECIPIENT, 1n));
  check('native send whose USDC cannot cover the fee: the existing title', nativeFeeShort instanceof AaFundingError && nativeFeeShort.title === AA_FUNDING_TITLE, nativeFeeShort?.title);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: errors and receipts');
// ---------------------------------------------------------------------------
{
  const aa33 = describeTokenGasError(new Error('RPC error -32500: AA33 reverted: ERC20: transfer amount exceeds balance (eth_estimateUserOperationGas)'));
  check('AA33 from the bundler: "refused" title, message verbatim', aa33?.title === TOKEN_GAS_REFUSED_TITLE && aa33.detail.startsWith('RPC error -32500: AA33 reverted'));
  check('unrelated errors are left to the other describers', describeTokenGasError(new Error('AA21 didn’t pay prefund')) === null && describeTokenGasError(new Error('boom')) === null);
  check('unavailable paymaster error keeps its reason', describeTokenGasError(new TokenGasUnavailableError('The paymaster is paused by its operator.'))?.title === TOKEN_GAS_UNAVAILABLE_TITLE);
  check('the funding title is shared with the other smart-account paths', AA_FUNDING_TITLE === 'Your smart account needs funds first.');

  const log = (o = {}) => ({
    address: o.paymaster ?? PAYMASTER,
    topics: [SPONSORED_TOPIC, ethers.zeroPadValue(o.token ?? USDC, 32), ethers.zeroPadValue(o.sender ?? KERNEL_ACCOUNT_0, 32)],
    data: abi.encode(['bytes32', 'uint256', 'uint256', 'uint256'], [o.hash ?? USEROP_HASH, PRICE, 5_392n, 0n]),
  });
  const expected = { userOpHash: USEROP_HASH, paymaster: PAYMASTER, token: USDC, sender: KERNEL_ACCOUNT_0 };
  const inReceipt = tokenGasChargeFromReceipt({ success: true, receipt: { transactionHash: '0x' + '12'.repeat(32), logs: [log()] } }, expected);
  check('the charge is read from the transaction receipt’s logs (ethers-encoded event)', inReceipt?.actualTokenNeeded === 5_392n && inReceipt.nativeTokenPrice === PRICE && inReceipt.feeTokenAmount === 0n);
  check('…or from the operation’s own logs', tokenGasChargeFromReceipt({ logs: [log()] }, expected)?.actualTokenNeeded === 5_392n);
  check('another operation’s event is ignored', tokenGasChargeFromReceipt({ logs: [log({ hash: '0x' + 'cd'.repeat(32) })] }, expected) === null);
  check('an event from another contract is ignored', tokenGasChargeFromReceipt({ logs: [log({ paymaster: RECIPIENT })] }, expected) === null);
  check('another sender or token is ignored', tokenGasChargeFromReceipt({ logs: [log({ sender: RECIPIENT }), log({ token: EURC })] }, expected) === null);
  check('malformed receipts give null, never a guess', tokenGasChargeFromReceipt(null, expected) === null && tokenGasChargeFromReceipt({ logs: [{ address: 1 }] }, expected) === null && tokenGasChargeFromReceipt('x', expected) === null);
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: the ETH path and the follow-ups');
// ---------------------------------------------------------------------------
{
  // The ETH path stays the default and its quotes are untouched.
  const node = tgNode({ usdc: 0n });
  const { bundle } = kernelBundle({ node });
  const q = await prepareAaSend(bundle, OWNER_0, RECIPIENT, 1n);
  check('an ETH-fee quote has no tokenGas key and still runs the bundler estimate', !('tokenGas' in q) && q.callGasLimit > 0n);
  const t = await prepareAaErc20Send(kernelBundle({ node: tgNode({ usdc: 5_000_000n }) }).bundle, OWNER_0, { contract: USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, amount: 1n, chainCaip2: BASE });
  check('(a) prepareAaErc20Send with chainCaip2: the quote’s token keeps exactly its display keys',
    Object.keys(t.token).join() === 'contract,recipient,amount,symbol,decimals' && !('tokenGas' in t));
  const counting = tgNode();
  const e1 = await rejection(() => prepareAaErc20Send(kernelBundle({ node: counting }).bundle, OWNER_0, { contract: USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, amount: 1n, chainCaip2: SEPOLIA }));
  check('(a) a token from another chain is refused by prepareAaErc20Send before any request', e1?.message.includes('belongs to eip155:11155111') && counting.calls.length === 0, e1?.message);
  const e2 = await rejection(() => maxAaErc20Send(kernelBundle({ node: counting }).bundle, OWNER_0, { contract: USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, chainCaip2: MAINNET }));
  check('(a) …and by maxAaErc20Send', e2?.message.includes('belongs to eip155:1') && counting.calls.length === 0, e2?.message);
  const send = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  const aaTokenCalls = send.match(/(?:prepareAaErc20Send|maxAaErc20Send|maxAaTokenGasErc20Send|prepareAaTokenGasErc20Send)\([^)]*?\{[\s\S]*?\}/g) ?? [];
  check('(a) every smart-account token quote and Max in SendScreen passes the token’s chain',
    aaTokenCalls.length === 5 && aaTokenCalls.every((c) => c.includes('chainCaip2: token.assetId.chainId')), `${aaTokenCalls.length}`);

  // (b) subscription token choices.
  const store = memoryStore();
  const extra = { kind: 'fungible', assetId: { chainId: BASE, namespace: 'erc20', reference: '0x' + '77'.repeat(20) }, symbol: 'TEST', name: 'Test token', decimals: 18 };
  // A missing key means the chain's defaults (the known tokens), so adding
  // one token stores defaults + that token.
  await addToken(extra, store);
  const loaded = await loadSubscriptionTokenChoices(BASE, 'test ETH', store);
  const base = subscriptionTokenChoices(BASE, 'test ETH');
  check('(b) the synchronous list is an exact prefix (an index chosen early keeps its meaning)',
    base.every((c, i) => loaded[i].token === c.token && loaded[i].symbol === c.symbol && loaded[i].decimals === c.decimals));
  check('(b) the tracked token follows, with its stored decimals; known tokens are not repeated',
    loaded.length === base.length + 1 && loaded.at(-1).symbol === 'TEST' && loaded.at(-1).decimals === 18 &&
      loaded.filter((c) => same(c.token, USDC)).length === 1);
  check('(b) another chain’s tracked tokens never appear', (await loadSubscriptionTokenChoices(SEPOLIA, 'test ETH', store)).every((c) => c.symbol !== 'TEST'));
  const broken = { getItem: async () => { throw new Error('storage unreadable'); }, setItem: async () => undefined };
  check('(b) an unreadable token store degrades to the synchronous list', (await loadSubscriptionTokenChoices(BASE, 'test ETH', broken)).length === base.length);
  const sessions = readFileSync(new URL('../src/screens/SessionsScreen.tsx', import.meta.url), 'utf8');
  check('(b) SessionsScreen loads the full list', sessions.includes('loadSubscriptionTokenChoices(evmChain.caip2, symbol)'));

  // (c) WcApprovalSheet names its chain.
  const sheet = readFileSync(new URL('../src/components/WcApprovalSheet.tsx', import.meta.url), 'utf8');
  check('(c) WcApprovalSheet passes evmChain.caip2 to listTokens explicitly', sheet.includes('listTokens(evmChain.caip2)') && !sheet.includes('listTokens()'));
}

// ---------------------------------------------------------------------------
console.log('check-token-gas: the ERC-7677 source (Pimlico’s ERC-20 paymaster on Ethereum Sepolia, phase 14 item 3)');
// ---------------------------------------------------------------------------
{
  const engine = await import('@shiba-wallet/chains-evm');
  const tg = await import('../src/wallet/token-gas.ts');
  const aa = await import('../src/wallet/aa.ts');
  const { keccak256 } = ethers;
  const PIM = engine.PIMLICO_ERC20_PAYMASTER_V07.address;
  const SEP_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const SEP_CHAIN = 11155111n;
  const TREASURY = '0xD8Baa107006C93a030d1455A2eF43261b384F21c';
  const RATE = 3_003_989_130n; // the live stub's rate on 2026-10-04 (USDC base units per 1 ETH)
  const POST_OP_GAS = 18_990n;
  const POST_OP_LIMIT = 0x10d7en;
  const code = readFileSync(new URL('./fixtures/pimlico-singleton-paymaster-v07.runtime.hex', import.meta.url), 'utf8').trim();
  check('fixture: the paymaster runtime code hashes to the pinned keccak (eth_getCode on Sepolia, 2026-10-04)',
    keccak256(code) === engine.PIMLICO_ERC20_PAYMASTER_V07.runtimeCodeKeccak && (code.length - 2) / 2 === 15_118);

  // Where the source is offered.
  check('tokenGasSourceFor: Circle on Base Sepolia; nothing on Ethereum Sepolia unless the screen accepts ERC-7677',
    tg.tokenGasSourceFor(BASE)?.kind === 'circle' && tg.tokenGasSourceFor(SEPOLIA) === null &&
      tg.tokenGasSourceFor(SEPOLIA, { acceptsErc7677: true })?.kind === 'erc7677' &&
      same(tg.tokenGasSourceFor(SEPOLIA, { acceptsErc7677: true })?.paymaster, PIM) &&
      same(tg.tokenGasSourceFor(SEPOLIA, { acceptsErc7677: true })?.token, SEP_USDC) &&
      tg.tokenGasSourceFor(MAINNET, { acceptsErc7677: true }) === null && tg.tokenGasSourceFor(BASE, { acceptsErc7677: true })?.kind === 'circle');
  const offer = (cfg, extra = {}) => tg.tokenGasOffer({ chainCaip2: SEPOLIA, config: cfg, owner: OWNER_0, passkeySigner: false, ...extra });
  check('offer on Ethereum Sepolia: unavailable with the existing sentence unless accepted; available (source erc7677) when accepted',
    offer(configFor(SEPOLIA)).kind === 'unavailable' && offer(configFor(SEPOLIA)).reason === tokenGasNotOnNetworkSentence(SEPOLIA) &&
      offer(configFor(SEPOLIA), { acceptsErc7677: true }).kind === 'available' &&
      offer(configFor(SEPOLIA), { acceptsErc7677: true }).source.kind === 'erc7677');
  check('offer refusals name this source: SimpleAccount, 7702, passkey; a sponsoring paymaster keeps its note',
    offer(configFor(SEPOLIA, { accountType: 'simple' }), { acceptsErc7677: true }).reason === tg.ERC7677_SIMPLE_ACCOUNT_NOTE &&
      offer(configFor(SEPOLIA, { eip7702Owners: [OWNER_0] }), { acceptsErc7677: true }).reason === tg.ERC7677_7702_NOTE &&
      offer(configFor(SEPOLIA), { acceptsErc7677: true, passkeySigner: true }).reason === tg.ERC7677_PASSKEY_NOTE &&
      offer(configFor(SEPOLIA, { paymasterUrl: 'https://pm.example' }), { acceptsErc7677: true }).reason === TOKEN_GAS_SPONSORED_NOTE);

  /** Fake Ethereum Sepolia node: the Kernel surface plus Pimlico's code, entryPoint() and deposit, USDC views. */
  function pimNode(opts = {}) {
    const state = { usdc: 5_000_000n, allowance: 0n, deposit: 140n * 10n ** 18n, staked: false, code, entryPoint: ENTRYPOINT_V07, ...opts };
    const calls = [];
    const tokenBalances = { [`${SEP_USDC.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`]: state.usdc };
    const inner = fakeKernelNode({
      chainIdHex: '0xaa36a7',
      balance: opts.eth ?? 10n ** 16n,
      tokenBalances,
      deployedAccounts: opts.deployed ? new Set([KERNEL_ACCOUNT_0]) : new Set(),
      owners: { [KERNEL_ACCOUNT_0.toLowerCase()]: OWNER_0 },
      calls,
    });
    const t = async (method, params) => {
      if (method === 'eth_getCode' && same(params[0], PIM)) {
        calls.push({ method, params });
        return state.code;
      }
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
      if (method === 'eth_maxPriorityFeePerGas') return '0xf4240';
      if (method === 'eth_call') {
        const [{ to, data }] = params;
        if (same(to, PIM) && data === sel('entryPoint()')) return pad32(state.entryPoint);
        if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getDepositInfo(address)'))) {
          return '0x' + [state.deposit, state.staked ? 1n : 0n, 0n, 0n, 0n].map((v) => word(v).slice(2)).join('');
        }
        if (same(to, SEP_USDC) && data === sel('decimals()')) return word(6);
        if (same(to, SEP_USDC) && data.startsWith(sel('allowance(address,address)'))) return word(state.allowance);
      }
      return inner(method, params);
    };
    t.calls = calls;
    t.state = state;
    tokenBalances.set = (v) => {
      tokenBalances[`${SEP_USDC.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`] = v;
    };
    t.tokenBalances = tokenBalances;
    return t;
  }

  /**
   * Fake ERC-7677 bundler: answers the two pm_ methods in Pimlico's
   * SingletonPaymasterV7 format (built here from the contract layout with
   * ethers.solidityPacked, independently of the engine encoder), estimates
   * like a bundler that runs postOp (the first call must approve enough and
   * the USDC left after the account's own transfers must cover the charge),
   * and records what is sent.
   */
  function pimBundler(node, opts = {}) {
    const terms = { rate: RATE, postOpGas: POST_OP_GAS, constantFee: 0n, recipient: null, preFund: 0n, paymaster: PIM, token: SEP_USDC, finalRate: null, ...opts };
    const calls = [];
    const pmData = (rate) => {
      const flags = (terms.constantFee > 0n ? 1 : 0) | (terms.recipient ? 2 : 0) | (terms.preFund > 0n ? 4 : 0);
      const types = ['uint8', 'uint8', 'uint48', 'uint48', 'address', 'uint128', 'uint256', 'uint128', 'address'];
      const values = [3, flags, 0, 0, terms.token, terms.postOpGas, rate, 1, TREASURY];
      if (terms.preFund > 0n) { types.push('uint128'); values.push(terms.preFund); }
      if (terms.constantFee > 0n) { types.push('uint128'); values.push(terms.constantFee); }
      if (terms.recipient) { types.push('address'); values.push(terms.recipient); }
      types.push('bytes');
      values.push('0x' + '11'.repeat(65));
      return ethers.solidityPacked(types, values);
    };
    const t = async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_chainId') return opts.chainIdHex ?? '0xaa36a7';
      if (method === 'rundler_maxPriorityFeePerGas') throw new Error('RPC error -32601: method not found');
      if (method === 'pimlico_getUserOperationGasPrice') {
        return { slow: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' }, standard: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' } };
      }
      if (method === 'pm_getPaymasterStubData') {
        return { paymaster: terms.paymaster, paymasterData: pmData(terms.rate), paymasterPostOpGasLimit: '0x' + POST_OP_LIMIT.toString(16) };
      }
      if (method === 'pm_getPaymasterData') {
        // Like ZeroDev's live answer: no gas limits in the final answer.
        return { paymaster: terms.paymaster, paymasterData: pmData(terms.finalRate ?? terms.rate) };
      }
      if (method === 'eth_estimateUserOperationGas') {
        const op = params[0];
        t.estimated.push(op);
        const exec = decodeKernelExecute(op.callData);
        const first = exec.calls[0];
        const approveIface = new ethers.Interface(['function approve(address,uint256)', 'function transfer(address,uint256)']);
        let approved = 0n;
        if (first && same(first.to, SEP_USDC) && first.data.startsWith(sel('approve(address,uint256)'))) {
          const [spender, amount] = approveIface.decodeFunctionData('approve', first.data);
          if (same(spender, PIM)) approved = amount;
        }
        let held = node.tokenBalances[`${SEP_USDC.toLowerCase()}|${op.sender.toLowerCase()}`] ?? 0n;
        for (const c of exec.calls.slice(1)) {
          if (same(c.to, SEP_USDC) && c.data.startsWith(sel('transfer(address,uint256)'))) held -= approveIface.decodeFunctionData('transfer', c.data)[1];
        }
        const fee = BigInt(op.maxFeePerGas);
        const charge = ((300_000n * fee + terms.postOpGas * fee) * terms.rate) / 10n ** 18n; // a realistic actual charge
        if (approved < charge) throw new Error('RPC error -32500: AA50 postOp reverted: ERC20: transfer amount exceeds allowance');
        if (held < charge) throw new Error('RPC error -32500: AA50 PostOp Reverted: Insufficient balance');
        return opts.estimate ?? {
          callGasLimit: '0xc404', verificationGasLimit: '0x16471', preVerificationGas: '0xd71e',
          paymasterVerificationGasLimit: '0xb578', paymasterPostOpGasLimit: '0xb98f',
        };
      }
      if (method === 'eth_sendUserOperation') {
        t.sent.push(params[0]);
        return USEROP_HASH;
      }
      throw new Error(`pim bundler: unexpected method ${method}`);
    };
    t.calls = calls;
    t.estimated = [];
    t.sent = [];
    t.terms = terms;
    return t;
  }
  function pimBundle({ node = pimNode(), bundler } = {}) {
    const b = bundler ?? pimBundler(node);
    const bundle = createAaClient({
      nodeUrl: NODE_URL,
      bundlerUrl: BUNDLER_URL,
      factory: KERNEL_V3_3.factory,
      chainId: SEP_CHAIN,
      accountIndex: 0,
      accountType: 'kernel-v3.3',
      transportFor: (url) => (url.includes('bundler') ? b : node),
    });
    return { bundle, node, bundler: b };
  }
  /** The bound written out from SingletonPaymasterV7 + EntryPoint v0.7, independently of the engine helper. */
  function expectedBound({ call, verification, pvg, pmVerification, postOpLimit, maxFee, rate = RATE, postOpGas = POST_OP_GAS, constantFee = 0n }) {
    const prefund = (call + verification + pvg + pmVerification + postOpLimit) * maxFee;
    const penalty = ((call + postOpLimit) * 10n) / 100n;
    return ((prefund + penalty * maxFee + postOpGas * maxFee) * rate) / 10n ** 18n + constantFee;
  }
  const PADDED = {
    call: (0xc404n * 130n) / 100n,
    verification: (0x16471n * 110n) / 100n,
    pvg: (0xd71en * 105n) / 100n,
    pmVerification: (0xb578n * 110n) / 100n,
  };

  // The on-chain + bundler check.
  {
    const node = pimNode();
    const bundler = pimBundler(node);
    const transportFor = (url) => (url.includes('bundler') ? bundler : node);
    tg.forgetTokenGasChecks();
    const none = await tg.checkTokenGasPaymaster(NODE_URL, SEPOLIA, { acceptsErc7677: true, transportFor, store: memoryStore() });
    check('check without a saved bundler: the needs-a-bundler sentence, nothing asked',
      none.ok === false && none.reason === tg.erc7677NeedsBundlerSentence('Ethereum Sepolia') && bundler.calls.length === 0, none.reason);
    check('…which reads exactly', tg.erc7677NeedsBundlerSentence('Ethereum Sepolia') ===
      'On Ethereum Sepolia, paying the network fee in USDC goes through Pimlico’s token paymaster, which is reached through the bundler saved in Settings → Account Abstraction. No bundler is saved for this network.');
    const ok = await tg.checkTokenGasPaymaster(NODE_URL, SEPOLIA, { acceptsErc7677: true, transportFor, bundlerUrl: BUNDLER_URL });
    check('check with the bundler: ok, the stub terms read (rate, postOpGas), context {token} sent',
      ok.ok === true && ok.source === 'erc7677' && ok.stub.exchangeRate === RATE && ok.stub.postOpGas === POST_OP_GAS &&
        JSON.stringify(bundler.calls.find((c) => c.method === 'pm_getPaymasterStubData')?.params[3]) === JSON.stringify({ token: SEP_USDC }));
    tg.forgetTokenGasChecks();
    const wrongChain = pimBundler(node, { chainIdHex: '0x14a34' });
    const wc = await tg.checkTokenGasPaymaster(NODE_URL, SEPOLIA, { acceptsErc7677: true, bundlerUrl: BUNDLER_URL, transportFor: (u) => (u.includes('bundler') ? wrongChain : node) });
    check('a bundler for another chain is refused before any paymaster question', wc.ok === false && /serves chain id 84532/.test(wc.reason) &&
      !wrongChain.calls.some((c) => c.method.startsWith('pm_')), wc.reason);
    tg.forgetTokenGasChecks();
    const tampered = pimNode({ code: code.slice(0, -2) + (code.endsWith('00') ? '01' : '00') });
    const tc = await tg.checkTokenGasPaymaster(NODE_URL, SEPOLIA, { acceptsErc7677: true, bundlerUrl: BUNDLER_URL, transportFor: (u) => (u.includes('bundler') ? pimBundler(tampered) : tampered) });
    check('different deployed code: refused (code hash)', tc.ok === false && /deployed code/.test(tc.reason), tc.reason);
    tg.forgetTokenGasChecks();
    const foreign = pimBundler(node, { paymaster: '0x' + '42'.repeat(20) });
    const fc = await tg.checkTokenGasPaymaster(NODE_URL, SEPOLIA, { acceptsErc7677: true, bundlerUrl: BUNDLER_URL, transportFor: (u) => (u.includes('bundler') ? foreign : node) });
    check('a bundler naming another paymaster: refused, with the wallet’s reason', fc.ok === false && /did not offer Pimlico’s token paymaster/.test(fc.reason) && /not 0x7777/.test(fc.reason), fc.reason);
    tg.forgetTokenGasChecks();
  }

  // The quote: estimated before the gate, the exact approval first, the bound recomputed independently.
  const { bundle: qb, bundler: qBundler } = pimBundle();
  const q = await tg.prepareAaTokenGasSend(qb, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
  const maxFee = q.maxFeePerGas;
  const bound = expectedBound({ ...PADDED, postOpLimit: POST_OP_LIMIT, maxFee });
  const expectedMax = (bound * 125n + 99n) / 100n;
  check('quote: source erc7677, Pimlico’s paymaster, Sepolia USDC (6 decimals read on-chain)',
    q.tokenGas.source === 'erc7677' && same(q.tokenGas.paymaster, PIM) && same(q.tokenGas.token, SEP_USDC) && q.tokenGas.decimals === 6);
  check('quote: the worst case = the contract formula over the padded estimate at the quote fees, + 25 % (independent recomputation)',
    q.tokenGas.erc7677.boundAtQuote === bound && q.tokenGas.maxTokenCharge === expectedMax, `${q.tokenGas.maxTokenCharge} vs ${expectedMax}`);
  check('quote: no ETH fee, gas fields = the padded estimate', q.fee === 0n &&
    q.callGasLimit === PADDED.call && q.verificationGasLimit === PADDED.verification && q.preVerificationGas === PADDED.pvg);
  const approveIface = new ethers.Interface(['function approve(address,uint256)']);
  check('quote: the first call approves Pimlico’s paymaster for EXACTLY the displayed worst case (ethers encoding)',
    same(q.calls[0].to, SEP_USDC) && q.calls[0].value === 0n && toHex(q.calls[0].data) === approveIface.encodeFunctionData('approve', [PIM, q.tokenGas.maxTokenCharge]) &&
      q.calls.length === 2 && same(q.calls[1].to, RECIPIENT));
  check('quote: nothing sent, only the stub and the estimate were asked (no final data before the gate)',
    qBundler.sent.length === 0 && !qBundler.calls.some((c) => c.method === 'pm_getPaymasterData') && qBundler.estimated.length === 1);
  check('quote: the estimate used a placeholder approval (the account’s whole USDC balance), never the unlimited value',
    (() => {
      const exec = decodeKernelExecute(qBundler.estimated[0].callData);
      return toHex(ethers.getBytes(exec.calls[0].data)) === approveIface.encodeFunctionData('approve', [PIM, 5_000_000n]);
    })());

  // Funding refusals before any bundler request.
  {
    const node = pimNode({ usdc: 0n });
    const { bundle, bundler } = pimBundle({ node });
    const e = await rejection(() => tg.prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true }));
    check('no USDC at all: funding error before the bundler is asked', e instanceof AaFundingError && e.title === AA_FUNDING_TITLE && bundler.calls.filter((c) => c.method.startsWith('pm_') || c.method.startsWith('eth_est')).length === 0, e?.message);
    const small = pimNode({ usdc: expectedMax - 1n });
    const { bundle: b2 } = pimBundle({ node: small });
    const e2 = await rejection(() => tg.prepareAaTokenGasSend(b2, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true }));
    check('USDC one unit below the worst case: funding error naming both figures', e2 instanceof AaFundingError && e2.message.includes(fmt6(expectedMax)), e2?.message);
  }

  // USDC send: amount + worst case must fit; Max = balance − worst case.
  {
    const usdcTarget = { contract: SEP_USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, chainCaip2: SEPOLIA };
    const { bundle } = pimBundle();
    const qq = await tg.prepareAaTokenGasErc20Send(bundle, OWNER_0, { ...usdcTarget, amount: 1_000_000n }, { acceptsErc7677: true });
    check('USDC send: approve first, then the transfer; total = amount + worst case ≤ balance',
      qq.calls.length === 2 && qq.token.amount === 1_000_000n && 1_000_000n + qq.tokenGas.maxTokenCharge <= 5_000_000n);
    const max = await tg.maxAaTokenGasErc20Send(bundle, OWNER_0, usdcTarget, { acceptsErc7677: true });
    check('USDC Max = balance − worst case (priced with a 1-unit transfer)', max > 0n && max < 5_000_000n, `${max}`);
    const over = await rejection(() => tg.prepareAaTokenGasErc20Send(bundle, OWNER_0, { ...usdcTarget, amount: 5_000_000n }, { acceptsErc7677: true }));
    check('USDC send of the whole balance (typed): refused, the fee would not fit', over instanceof AaFundingError, over?.message);
    const ethMax = await tg.maxAaTokenGasSend(bundle, OWNER_0, { acceptsErc7677: true });
    check('ETH Max with the USDC fee = the full ETH balance', ethMax === 10n ** 16n);
  }

  // Emulator finding 2 (phase 14 pass): the risk card on an ERC-7677 USDC-fee
  // confirm described the inserted paymaster approval instead of the user's
  // own call. aaRiskWarningTarget must skip exactly that approval, so the
  // card equals the ETH-fee card for the same send.
  {
    const riskOf = (t) => ({ to: t.to.toLowerCase(), data: toHex(t.data), counterparty: t.counterparty?.toLowerCase() ?? null });
    const eq = (a, b) => JSON.stringify(riskOf(a)) === JSON.stringify(riskOf(b));
    const native7677 = await tg.prepareAaTokenGasSend(pimBundle().bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    const nativeEth = { calls: [{ to: RECIPIENT, value: 0n, data: new Uint8Array(0) }] };
    check('risk card (ERC-7677, native send): the user’s call, equal to the ETH-fee card', eq(aaRiskWarningTarget(native7677), aaRiskWarningTarget(nativeEth)) && same(aaRiskWarningTarget(native7677).to, RECIPIENT));
    check('aaUserCalls drops only the inserted approval', aaUserCalls(native7677).length === 1 && same(aaUserCalls(native7677)[0].to, RECIPIENT));
    const usdcTarget = { contract: SEP_USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6, chainCaip2: SEPOLIA };
    const token7677 = await tg.prepareAaTokenGasErc20Send(pimBundle().bundle, OWNER_0, { ...usdcTarget, amount: 1_000_000n }, { acceptsErc7677: true });
    const tokenEth = { calls: aaErc20TransferCalls(SEP_USDC, RECIPIENT, 1_000_000n), token: token7677.token };
    check('risk card (ERC-7677, USDC send): the transfer with the recipient as counterparty, equal to the ETH-fee card',
      eq(aaRiskWarningTarget(token7677), aaRiskWarningTarget(tokenEth)) && same(aaRiskWarningTarget(token7677).counterparty, RECIPIENT));
    // A user-requested approve is never skipped: not when it is the only
    // call after the inserted one, not when the first call differs from the
    // exact inserted approval, and not on a quote of another source.
    const approveIface = new ethers.Interface(['function approve(address,uint256)']);
    const userApprove = { to: SEP_USDC, value: 0n, data: ethers.getBytes(approveIface.encodeFunctionData('approve', [RECIPIENT, 7n])) };
    const withUserApprove = { ...native7677, calls: [native7677.calls[0], userApprove] };
    check('a user approve after the inserted one is what the card describes', toHex(aaRiskWarningTarget(withUserApprove).data) === toHex(userApprove.data));
    const differentFirst = { ...native7677, calls: [engine.erc7677TokenApproveCall(SEP_USDC, PIM, native7677.tokenGas.maxTokenCharge + 1n), ...native7677.calls.slice(1)] };
    check('a first approve that is not the exact inserted one is not skipped', aaUserCalls(differentFirst).length === 2 && toHex(aaRiskWarningTarget(differentFirst).data) === toHex(differentFirst.calls[0].data));
    const circleLike = { ...native7677, tokenGas: { ...native7677.tokenGas, source: undefined } };
    check('the same calls on a non-ERC-7677 quote are not trimmed', aaUserCalls(circleLike).length === 2);
    const aloneApproval = { ...native7677, calls: [native7677.calls[0]] };
    check('an approval with no call after it is not skipped (nothing to describe otherwise)', aaUserCalls(aloneApproval).length === 1);
    const aaSrc = readFileSync(new URL('../src/wallet/aa.ts', import.meta.url), 'utf8');
    const skipAnchor = '  return isInserted ? quote.calls.slice(1) : quote.calls;';
    check('mutation anchor present (risk-card skip)', aaSrc.includes(skipAnchor) && aaSrc.includes('  const first = aaUserCalls(quote)[0]!;'));
    const noSkip = await importMutantTg('src/wallet/aa.ts', aaSrc.replace(skipAnchor, '  return quote.calls;'));
    check('M-r1 caught: without the skip the card describes the paymaster approval', !eq(noSkip.aaRiskWarningTarget(native7677), aaRiskWarningTarget(nativeEth)));
    const skipAny = await importMutantTg('src/wallet/aa.ts', aaSrc.replace(skipAnchor, '  return quote.calls.slice(1);'));
    check('M-r2 caught: skipping any first call would hide a non-matching approve', skipAny.aaUserCalls(differentFirst).length === 1 && aaUserCalls(differentFirst).length === 2);
  }

  // Send: after the gate, the final terms are checked against the displayed maximum.
  {
    const { bundle, bundler } = pimBundle();
    const quote = await tg.prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    await sendAa(bundle, owner, quote);
    const op = bundler.sent[0];
    check('sent: one operation through Pimlico’s paymaster, final data asked with context {token}',
      bundler.sent.length === 1 && same(op.paymaster, PIM) &&
        JSON.stringify(bundler.calls.find((c) => c.method === 'pm_getPaymasterData')?.params[3]) === JSON.stringify({ token: SEP_USDC }));
    const exec = decodeKernelExecute(op.callData);
    check('sent: the signed callData approves exactly the displayed maximum, then the reviewed call',
      exec.calls.length === 2 && approveIface.encodeFunctionData('approve', [PIM, quote.tokenGas.maxTokenCharge]) === ethers.hexlify(exec.calls[0].data) &&
        same(exec.calls[1].to, RECIPIENT));
    check('sent: exactly the quoted fees', BigInt(op.maxFeePerGas) === quote.maxFeePerGas && BigInt(op.maxPriorityFeePerGas) === quote.maxPriorityFeePerGas);
    const full = {
      ...fromRpcOp(op),
      paymaster: op.paymaster,
      paymasterVerificationGasLimit: BigInt(op.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit),
      paymasterData: toBytes(op.paymasterData),
    };
    check('sent: the postOp limit is the stub’s (the final answer omitted it)', full.paymasterPostOpGasLimit === POST_OP_LIMIT);
    const hash = getUserOpHash(full, ENTRYPOINT_V07, SEP_CHAIN);
    check('sent: the userOp signature (covering paymasterAndData) recovers to the owner (ethers)', ethers.verifyMessage(hash, op.signature) === OWNER_0);
    const signedBound = expectedBound({
      call: full.callGasLimit, verification: full.verificationGasLimit, pvg: full.preVerificationGas,
      pmVerification: full.paymasterVerificationGasLimit, postOpLimit: full.paymasterPostOpGasLimit, maxFee: full.maxFeePerGas,
    });
    check('sent: the bound of what was signed is within the displayed maximum (= the approval)', signedBound <= quote.tokenGas.maxTokenCharge, `${signedBound} ≤ ${quote.tokenGas.maxTokenCharge}`);
  }
  {
    // The rate in the final answer rises past the headroom → refused before signing.
    const node = pimNode();
    const bundler = pimBundler(node);
    const { bundle } = pimBundle({ node, bundler });
    const quote = await tg.prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    bundler.terms.finalRate = (RATE * 126n) / 100n;
    const e = await rejection(() => sendAa(bundle, owner, quote));
    check('final rate +26 %: TokenGasChargeAboveLimitError before signing; nothing sent', e instanceof TokenGasChargeAboveLimitError && e.limit === quote.tokenGas.maxTokenCharge && bundler.sent.length === 0, e?.message);
    const d = tg.describeTokenGasError(e, quote.tokenGas);
    check('…worded with the fee-changed title and both amounts', d?.title === TOKEN_GAS_FEE_ROSE_TITLE && d.detail.includes(fmt6(quote.tokenGas.maxTokenCharge)));
    const node2 = pimNode();
    const bundler2 = pimBundler(node2);
    const { bundle: bundle2 } = pimBundle({ node: node2, bundler: bundler2 });
    const quote2 = await tg.prepareAaTokenGasSend(bundle2, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    bundler2.terms.finalRate = (RATE * 120n) / 100n;
    await sendAa(bundle2, owner, quote2);
    check('final rate +20 % (inside the 25 % headroom): sent', bundler2.sent.length === 1);
  }
  {
    // Final data with a recipient or a preFund is refused before signing.
    for (const [label, extra] of [['recipient', { recipient: '0x' + '33'.repeat(20) }], ['preFund', { preFund: 1n }]]) {
      const node = pimNode();
      const bundler = pimBundler(node);
      const { bundle } = pimBundle({ node, bundler });
      const quote = await tg.prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
      Object.assign(bundler.terms, extra);
      const e = await rejection(() => sendAa(bundle, owner, quote));
      check(`final data with a ${label}: refused before signing, nothing sent`, e !== null && new RegExp(label).test(e.message) && bundler.sent.length === 0, e?.message);
    }
  }
  {
    // A quote whose approval was altered after review is refused.
    const { bundle, bundler } = pimBundle();
    const quote = await tg.prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    const tampered = { ...quote, calls: [engine.erc7677TokenApproveCall(SEP_USDC, PIM, quote.tokenGas.maxTokenCharge * 2n), ...quote.calls.slice(1)] };
    const e = await rejection(() => sendAa(bundle, owner, tampered));
    check('an approval larger than the displayed maximum: refused before anything is asked or signed',
      e !== null && /does not start by approving exactly/.test(e.message) && bundler.sent.length === 0 && !bundler.calls.some((c) => c.method === 'pm_getPaymasterData'), e?.message);
    const aaSrc = readFileSync(new URL('../src/wallet/aa.ts', import.meta.url), 'utf8');
    const anchor = '  assertErc7677ApprovalCall(quote);\n  const transport = createErc7677TokenPaymasterTransport({';
    const mutant = await importMutantTg('src/wallet/aa.ts', aaSrc.replace(anchor, '  const transport = createErc7677TokenPaymasterTransport({'));
    check('mutation anchor present', aaSrc.includes(anchor));
    const mb = pimBundle();
    const mq = await tg.prepareAaTokenGasSend(mb.bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    const mbundle = mutant.createAaClient({
      nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: KERNEL_V3_3.factory, chainId: SEP_CHAIN, accountIndex: 0, accountType: 'kernel-v3.3',
      transportFor: (url) => (url.includes('bundler') ? mb.bundler : mb.node),
    });
    await mutant.sendAa(mbundle, owner, { ...mq, calls: [engine.erc7677TokenApproveCall(SEP_USDC, PIM, mq.tokenGas.maxTokenCharge * 2n), ...mq.calls.slice(1)] }).catch(() => null);
    check('M-a caught: without the approval check a doubled approval would be sent', mb.bundler.sent.length === 1);
  }
  {
    // Headroom mutation: the displayed maximum must include the 25 %.
    const tgSrc = readFileSync(new URL('../src/wallet/token-gas.ts', import.meta.url), 'utf8');
    const anchor = 'const maxTokenCharge = (bound * (100n + ERC7677_TOKEN_GAS_HEADROOM_PERCENT) + 99n) / 100n;';
    check('mutation anchor present (headroom)', tgSrc.includes(anchor));
    const mutant = await importMutantTg('src/wallet/token-gas.ts', tgSrc.replace(anchor, 'const maxTokenCharge = bound;'));
    const { bundle } = pimBundle();
    const mq = await mutant.prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    check('M-b caught: without the headroom the displayed maximum differs from the checked figure', mq.tokenGas.maxTokenCharge !== expectedMax);
  }

  // Sentences.
  const lines = tg.tokenGasConfirmLines(q.tokenGas, { chainCaip2: SEPOLIA, nativeSymbol: 'test ETH', maxFeePerGas: q.maxFeePerGas });
  const m = fmt6(q.tokenGas.maxTokenCharge);
  check('confirm: fee sentence', lines.feeSentence ===
    `Network fee paid in USDC: up to ${m} USDC. This operation first approves Pimlico’s paymaster for exactly ${m} USDC; after your calls run, it takes the actual fee, which can be less. No ETH is needed for the fee.`, lines.feeSentence);
  check('confirm: rate set by Pimlico, not an oracle', lines.rateValue ===
    '1 test ETH = 3003.98913 USDC, set by Pimlico’s service and signed into the operation; it is not read from an on-chain oracle.', lines.rateValue);
  check('confirm: markup row and note', lines.spreadLabel === 'Paymaster markup' && lines.spreadValue === 'Included in the rate; not shown as a separate figure' &&
    lines.spreadNote === 'Pimlico says its fee is built into the exchange rate it returns, and services that resell its paymaster may add their own (ZeroDev documents a 5% premium on the rate).');
  check('confirm: grant sentence says what stays approved and who can use it', lines.grantSentence ===
    `This operation approves Pimlico’s paymaster to take up to ${m} USDC from your smart account. It takes only the actual fee; the rest of the approval (up to ${m} USDC minus the fee) stays in place afterwards. Only operations from this smart account that use this paymaster can draw on it, and the next one replaces it with a new exact approval.`, lines.grantSentence);
  check('confirm: permissioned and unstaked notes', lines.notes.length === 2 &&
    lines.notes[0] === 'Pimlico’s paymaster is a permissioned service: its server signs each operation and can decline any of them. If it declines, nothing is sent.' &&
    lines.notes[1] === 'This paymaster is not staked in the EntryPoint on Ethereum Sepolia, so some bundlers may refuse operations that use it.');
  check('confirm: labels and the estimate line', lines.paymasterLabel === 'Paymaster (Pimlico)' && same(lines.paymasterValue, PIM) &&
    lines.estimateSentence === 'Bundler gas estimate passed with Pimlico’s paymaster terms.' && lines.feeLabel === 'Network fee (paid in USDC)');
  check('confirm: the worst-case hint names the headroom and the refusal', lines.worstCaseHint.includes('plus 25% headroom in case Pimlico’s rate moves') &&
    lines.worstCaseHint.endsWith('If Pimlico’s final terms would cost more than this, nothing is signed.'), lines.worstCaseHint);
  const withEarlier = tg.tokenGasConfirmLines({ ...q.tokenGas, erc7677: { ...q.tokenGas.erc7677, allowanceBefore: 1_500_000n } }, { chainCaip2: SEPOLIA, nativeSymbol: 'test ETH', maxFeePerGas: 1n });
  check('confirm: an existing approval is named as replaced', withEarlier.grantSentence.includes(', replacing an earlier approval of 1.5 USDC.'));
  check('choice hint names the permissioned service', tg.erc7677ChoiceHint() ===
    'Pimlico’s token paymaster pays the gas and takes USDC from your smart account instead. It is a permissioned service: Pimlico sets the rate, must sign each operation, and can decline. The confirm screen shows the most it can take before you approve; ETH stays the default.');
  // Circle lines are the existing functions, unchanged.
  const { bundle: cb } = kernelBundle();
  const cq = await prepareAaTokenGasSend(cb, OWNER_0, RECIPIENT, 1n);
  const cl = tg.tokenGasConfirmLines(cq.tokenGas, { chainCaip2: BASE, nativeSymbol: 'test ETH', maxFeePerGas: cq.maxFeePerGas });
  const cmax = fmt6(cq.tokenGas.maxTokenCharge);
  check('Circle confirm lines are exactly the existing sentences',
    cl.feeSentence === tokenGasFeeSentence(cmax) && cl.grantSentence === tokenGasGrantSentence(cmax) &&
      cl.rateNote === TOKEN_GAS_FIXED_ORACLE_NOTE && cl.spreadValue === tokenGasSpreadText(cq.tokenGas.feeSpreadBips) &&
      cl.paymasterLabel === 'Paymaster (Circle)' && cl.estimateSentence === TOKEN_GAS_ESTIMATE_AFTER_APPROVAL && cl.notes.length === 0);
  check('preview footnote for the ERC-7677 quote names the approval and Pimlico', aa.aaPreviewNote(q) === aa.previewErc7677TokenGasNote('USDC', 'Pimlico') &&
    aa.aaPreviewNote(q).includes('The first call approves Pimlico’s paymaster for the most the network fee can cost'));
  check('Circle’s preview footnotes are unchanged (default paymaster name)', aa.previewTokenGasNote('USDC') ===
    'Simulated as a direct call from your smart account. The network fee is paid in USDC through Circle’s paymaster and is shown above; it is not part of this list.');

  // Errors.
  const refusal = new tg.TokenGasPaymasterRefusalError('RPC error -32500: AA50 PostOp Reverted: Insufficient balance', 'Pimlico’s token paymaster');
  check('a refusal while quoting: titled with Pimlico’s name, the bundler text verbatim',
    tg.describeTokenGasError(refusal)?.title === 'Pimlico’s token paymaster refused the operation.' && tg.describeTokenGasError(refusal).detail.startsWith('RPC error -32500: AA50 PostOp Reverted'));
  check('AA50 on an ERC-7677 quote is the paymaster’s refusal; on Circle’s it is not classified', tg.describeTokenGasError(new Error('AA50 postOp reverted'), q.tokenGas)?.title === 'Pimlico’s token paymaster refused the operation.' &&
    tg.describeTokenGasError(new Error('AA50 postOp reverted')) === null);
  check('Circle’s AA33 wording is unchanged', tg.describeTokenGasError(new Error('AA33 reverted'))?.title === TOKEN_GAS_REFUSED_TITLE);
  check('an unavailable error carrying Pimlico’s name gets its title', tg.describeTokenGasError(new TokenGasUnavailableError('x', 'Pimlico’s token paymaster'))?.title === 'Pimlico’s token paymaster cannot be used right now.' &&
    tg.describeTokenGasError(new TokenGasUnavailableError('x'))?.title === TOKEN_GAS_UNAVAILABLE_TITLE);

  // Receipt: Pimlico's UserOperationSponsored, encoded with ethers.
  const PIM_TOPIC = ethers.id('UserOperationSponsored(bytes32,address,uint8,address,uint256,uint256)');
  const pimLog = {
    address: PIM.toLowerCase(),
    topics: [PIM_TOPIC, USEROP_HASH, pad32(KERNEL_ACCOUNT_0)],
    data: abi.encode(['uint8', 'address', 'uint256', 'uint256'], [1, SEP_USDC, 760_363n, RATE]),
  };
  const charge = tokenGasChargeFromReceipt({ logs: [pimLog] }, { userOpHash: USEROP_HASH, paymaster: PIM, token: SEP_USDC, sender: KERNEL_ACCOUNT_0 });
  check('receipt: the charge is Pimlico’s tokenAmountPaid for exactly this operation (the live run’s 760363)', charge?.actualTokenNeeded === 760_363n && charge.nativeTokenPrice === RATE);
  check('receipt: another userOpHash, sender or a verifying-mode event → null', tokenGasChargeFromReceipt({ logs: [pimLog] }, { userOpHash: '0x' + '00'.repeat(32), paymaster: PIM, token: SEP_USDC, sender: KERNEL_ACCOUNT_0 }) === null &&
    tokenGasChargeFromReceipt({ logs: [{ ...pimLog, data: abi.encode(['uint8', 'address', 'uint256', 'uint256'], [0, ethers.ZeroAddress, 0n, 0n]) }] }, { userOpHash: USEROP_HASH, paymaster: PIM, token: SEP_USDC, sender: KERNEL_ACCOUNT_0 }) === null);
  check('success line for either source', tg.tokenGasChargedLine(q.tokenGas, 760_363n) ===
    `Network fee charged: 0.760363 USDC. The approval allowed up to ${m} USDC; what was not charged stays approved for Pimlico’s paymaster until a later operation through it replaces the approval.` &&
    tg.tokenGasChargedLine(q.tokenGas, null) === 'The receipt did not include Pimlico’s fee event, so the USDC charge could not be read from it.' &&
    tg.tokenGasChargedLine(cq.tokenGas, 5_776n) === tokenGasChargedSentence('0.005776', cmax));
  // Arbitrum Sepolia (phase 14 item 3): Circle's paymaster, checked on-chain there.
  const ARB = 'eip155:421614';
  check('Arbitrum Sepolia: Circle’s v0.7 paymaster with Circle’s Arbitrum Sepolia USDC (Circle docs + token() on-chain)',
    tokenGasPaymasterFor(ARB)?.paymaster === '0x31BE08D380A21fc740883c0BC434FcFc88740b58' &&
      tokenGasPaymasterFor(ARB)?.token === '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' &&
      tg.tokenGasSourceFor(ARB, { acceptsErc7677: true })?.kind === 'circle');
  check('Arbitrum Sepolia: offered (Circle source) for a Kernel account without any screen opt-in',
    tg.tokenGasOffer({ chainCaip2: ARB, config: configFor(ARB), owner: OWNER_0, passkeySigner: false }).kind === 'available' &&
      tg.tokenGasOffer({ chainCaip2: ARB, config: configFor(ARB), owner: OWNER_0, passkeySigner: false }).source.kind === 'circle');
  check('Arbitrum Sepolia: the fixed-oracle note names it; Base’s note is unchanged',
    tokenGasOracleNote(ARB) === 'On Arbitrum Sepolia the paymaster’s test oracle returns a fixed price; it is not a market rate.' &&
      tokenGasOracleNote(BASE) === TOKEN_GAS_FIXED_ORACLE_NOTE && tokenGasOracleNote(SEPOLIA) === null);
  check('the Circle networks come from the profiles: Base Sepolia and Arbitrum Sepolia', tg.tokenGasNetworkLabels().join() === 'Base Sepolia,Arbitrum Sepolia');
  check('token sends on Arbitrum Sepolia mention the USDC choice', tokenSendFeeSentence(ARB) ===
    'The network fee for a token send is normally paid in test ETH, not in the token. On Arbitrum Sepolia, a smart-account send can pay it in USDC instead when the Send screen offers that choice.');
  check('the not-on-network sentence lists the Circle networks from the profiles', tokenGasNotOnNetworkSentence(MAINNET).startsWith(
    `Paying the network fee in USDC is offered only on ${tg.tokenGasNetworkLabels().join(' and ')}, where Circle’s token paymaster`));

  // -------------------------------------------------------------------------
  // SendScreen wiring for both sources (phase 14 integration slice). The
  // screen cannot run in Node, so its wiring is checked at the source level
  // by sendScreenWiringProblems(); each mutation below must be caught. The
  // Circle strings are pinned byte for byte by re-rendering them the way the
  // screen did before this change (the old expressions, copied verbatim).
  // -------------------------------------------------------------------------
  console.log('check-token-gas: SendScreen wiring for both USDC-fee sources');
  const { formatUnits: fmtUnits } = await import('../src/wallet/balances.ts');
  const ex = (v, d) => fmtUnits(v, d, d);
  const sendPath = new URL('../src/screens/SendScreen.tsx', import.meta.url);
  const sendNow = readFileSync(sendPath, 'utf8');
  function sendScreenWiringProblems(src) {
    const problems = [];
    const need = (what, ok) => { if (!ok) problems.push(what); };
    need('confirm lines built once from the quote and the active profile',
      src.includes('tokenGasConfirmLines(quote.tokenGas, {\n          chainCaip2: evmChain.caip2,\n          nativeSymbol: evmChain.displaySymbol,\n          maxFeePerGas: quote.maxFeePerGas,\n        })'));
    for (const field of ['feeLabel', 'feeValue', 'feeSentence', 'worstCaseHint', 'rateValue', 'rateNote', 'spreadLabel', 'spreadValue', 'spreadNote', 'paymasterLabel', 'paymasterValue', 'balanceLabel', 'balanceValue', 'grantSentence', 'estimateSentence', 'throughPhrase']) {
      need(`renders tgLines.${field}`, src.includes(`tgLines.${field}`));
    }
    need('grant sentence in the warning box', src.includes('<WarningBox>{tgLines.grantSentence}</WarningBox>'));
    need('every extra note rendered', src.includes('{tgLines.notes.map((n) => ('));
    need('no Circle-only sentence left on the confirm or success screens',
      !['tokenGasFeeSentence(', 'tokenGasGrantSentence(', 'tokenGasRateSentence(', 'tokenGasSpreadText(', 'tokenGasOracleNote(', 'tokenGasWorstCaseHint(',
        'label="Paymaster (Circle)"', 'TOKEN_GAS_ESTIMATE_AFTER_APPROVAL', 'TOKEN_GAS_NO_CHARGE_EVENT', 'tokenGasChargedSentence(', 'TOKEN_GAS_SPREAD_NOTE',
        "'Circle\\u2019s paymaster (see below).'"].some((x) => src.includes(x)));
    need('success line from the source', src.includes('{tokenGasChargedLine(quote.tokenGas, aaResult.tokenGasCharge)}'));
    need('the ERC-7677 estimate line is the source’s pass sentence in the success style',
      src.includes("{tgLines && quote.tokenGas?.source === 'erc7677' ? (") && src.includes('<Text style={[styles.simulationOk, { color: theme.success }]}>{tgLines.estimateSentence}</Text>'));
    need('every other smart-account quote keeps “Bundler gas estimate passed”', src.includes('Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).'));
    need('acceptsErc7677: true on the check key, the check, the offer, both Max calls and both quotes (7)',
      (src.match(/acceptsErc7677: true/g) ?? []).length === 7);
    need('the check key names the source and the saved bundler',
      src.includes("tokenGasSourceFor(evmChain.caip2, { acceptsErc7677: true })\n      ? `${evmChain.caip2}|${aaNodeUrl}|${aaBundlerUrl ?? ''}`"));
    need('the check asks the saved bundler and re-runs when it changes',
      src.includes('checkTokenGasPaymaster(aaNodeUrl, evmChain.caip2, { acceptsErc7677: true, bundlerUrl: aaBundlerUrl })') &&
        src.includes('}, [tokenGasCheckKey, aaNodeUrl, evmChain.caip2, aaBundlerUrl]);'));
    need('switch box: the ERC-7677 checking sentence and hint, Circle’s unchanged',
      src.includes("tokenGasOfferNow.source.kind === 'erc7677'\n                ? erc7677CheckingSentence(tokenGasOfferNow.source.vendor)\n                : 'Checking Circle\\u2019s token paymaster on-chain before offering to pay the network fee in USDC\\u2026'") &&
        src.includes("? erc7677ChoiceHint(tokenGasOfferNow.source.vendor)\n                  : TOKEN_GAS_CHOICE_HINT}"));
    need('the circle-only lookup is gone', !src.includes('tokenGasPaymasterFor('));
    need('risk card, spending-policy hook and preview unchanged',
      src.includes('<RiskWarnings url={confirmUrl} wallet={quote.sender} {...aaRiskWarningTarget(quote)} />') &&
        src.includes('<SpendingPolicyNotice owner={quotedFrom} quote={quote} from={quotedFrom} />') && src.includes('note={aaPreviewNote(quote)}'));
    return problems;
  }
  const wiring = sendScreenWiringProblems(sendNow);
  check('SendScreen wires both USDC-fee sources (source-level pins)', wiring.length === 0, wiring.join('; '));
  const mutants = [
    ['M-w1 the offer without acceptsErc7677', 'passkeySigner: passkeyActive,\n        acceptsErc7677: true,\n      })', 'passkeySigner: passkeyActive,\n      })'],
    ['M-w2 the grant row emptied', '<WarningBox>{tgLines.grantSentence}</WarningBox>', '<WarningBox>{tgLines.feeSentence}</WarningBox>'],
    ['M-w3 the success line back to Circle’s constant', '{tokenGasChargedLine(quote.tokenGas, aaResult.tokenGasCharge)}', '{TOKEN_GAS_NO_CHARGE_EVENT}'],
    ['M-w4 the check key without the bundler', "|${aaNodeUrl}|${aaBundlerUrl ?? ''}`", '|${aaNodeUrl}`'],
    ['M-w5 the notes dropped', '{tgLines.notes.map((n) => (', '{[].map((n) => ('],
    ['M-w6 the check without the saved bundler', ', { acceptsErc7677: true, bundlerUrl: aaBundlerUrl })', ')'],
    ['M-w7 the risk card removed', '<RiskWarnings url={confirmUrl} wallet={quote.sender} {...aaRiskWarningTarget(quote)} />', ''],
  ];
  for (const [name, from, to] of mutants) {
    check(`mutation anchor present (${name})`, sendNow.includes(from));
    check(`${name}: caught`, sendScreenWiringProblems(sendNow.replace(from, to)).length > 0);
  }

  // Circle: every string the confirm, the switch box and the success screen
  // render is byte-identical to the earlier screen (the old expressions,
  // copied verbatim from SendScreen.tsx at 1823d8c).
  // (The fake node serves Base Sepolia; the only per-chain line, the oracle
  // note, is pinned for Arbitrum Sepolia above.)
  {
    const chain = BASE;
    const cqq = await prepareAaTokenGasSend(kernelBundle().bundle, OWNER_0, RECIPIENT, 1n);
    const t = cqq.tokenGas;
    const nat = 'test ETH';
    const L = tg.tokenGasConfirmLines(t, { chainCaip2: chain, nativeSymbol: nat, maxFeePerGas: cqq.maxFeePerGas });
    const old = [
      `Network fee (paid in ${t.symbol})`,
      `up to ${ex(t.maxTokenCharge, t.decimals)} ${t.symbol}`,
      tokenGasFeeSentence(ex(t.maxTokenCharge, t.decimals), t.symbol),
      tg.tokenGasWorstCaseHint(t, cqq.maxFeePerGas),
      tokenGasRateSentence(t.nativeTokenPrice, t.decimals, nat, t.symbol),
      tokenGasOracleNote(chain),
      'Paymaster fee spread',
      tokenGasSpreadText(t.feeSpreadBips),
      tg.TOKEN_GAS_SPREAD_NOTE,
      'Paymaster (Circle)',
      t.paymaster,
      `Smart account ${t.symbol} balance`,
      `${ex(t.tokenBalance, t.decimals)} ${t.symbol}`,
      tokenGasGrantSentence(ex(t.maxTokenCharge, t.decimals), t.symbol),
      TOKEN_GAS_ESTIMATE_AFTER_APPROVAL,
      `One transfer call executed by the smart account: it sends its own USDC, so no approval is needed. The network fee is paid in ${t.symbol} through ` + 'Circle’s paymaster (see below).',
      tg.TOKEN_GAS_NO_CHARGE_EVENT,
      tokenGasChargedSentence(ex(5_776n, t.decimals), ex(t.maxTokenCharge, t.decimals), t.symbol),
    ];
    const now = [
      L.feeLabel, L.feeValue, L.feeSentence, L.worstCaseHint, L.rateValue, L.rateNote, L.spreadLabel, L.spreadValue, L.spreadNote,
      L.paymasterLabel, L.paymasterValue, L.balanceLabel, L.balanceValue, L.grantSentence, L.estimateSentence,
      `One transfer call executed by the smart account: it sends its own USDC, so no approval is needed. The network fee is paid in ${t.symbol} through ` + `${L.throughPhrase} (see below).`,
      tg.tokenGasChargedLine(t, null),
      tg.tokenGasChargedLine(t, 5_776n),
    ];
    const diff = old.map((o, i) => (o === now[i] ? null : i)).filter((i) => i !== null);
    check(`Circle on ${chain}: all 18 rendered strings byte-identical to the earlier screen, no extra notes`, diff.length === 0 && L.notes.length === 0, diff.join());
  }
  check('Circle’s choice hint and checking sentence are unchanged',
    tg.TOKEN_GAS_CHOICE_HINT === 'Circle’s token paymaster pays the gas and takes USDC from your smart account instead. The confirm screen shows the most it can take before you approve; ETH stays the default.' &&
      'Checking Circle’s token paymaster on-chain before offering to pay the network fee in USDC…' === 'Checking Circle’s token paymaster on-chain before offering to pay the network fee in USDC…');

  // ERC-7677 on Ethereum Sepolia: what the wired screen now shows.
  {
    const { bundle } = pimBundle();
    const pq = await tg.prepareAaTokenGasSend(bundle, OWNER_0, RECIPIENT, 0n, { acceptsErc7677: true });
    const L = tg.tokenGasConfirmLines(pq.tokenGas, { chainCaip2: SEPOLIA, nativeSymbol: 'test ETH', maxFeePerGas: pq.maxFeePerGas });
    check('ERC-7677 on the wired screen: the grant row says the remainder of the approval stays in place',
      L.grantSentence.includes('the rest of the approval (up to ') && L.grantSentence.includes('stays in place afterwards'));
    check('ERC-7677 on the wired screen: the estimate line is the source’s pass sentence',
      L.estimateSentence === 'Bundler gas estimate passed with Pimlico’s paymaster terms.' && pq.tokenGas.source === 'erc7677');
    check('ERC-7677 on the wired screen: the token-send hint names Pimlico’s paymaster',
      `${L.throughPhrase} (see below).` === 'Pimlico’s paymaster (see below).');
    check('ERC-7677 on the wired screen: the checking sentence names the bundler',
      tg.erc7677CheckingSentence('Pimlico') === 'Checking Pimlico’s token paymaster on-chain and asking the configured bundler for its terms before offering to pay the network fee in USDC…');
    check('the offer the screen requests on Sepolia is the ERC-7677 source; without the opt-in it is not offered',
      tg.tokenGasOffer({ chainCaip2: SEPOLIA, config: configFor(SEPOLIA), owner: OWNER_0, passkeySigner: false, acceptsErc7677: true }).kind === 'available' &&
        tg.tokenGasOffer({ chainCaip2: SEPOLIA, config: configFor(SEPOLIA), owner: OWNER_0, passkeySigner: false }).kind === 'unavailable');
  }
}

console.log('');
console.log(`check-token-gas: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

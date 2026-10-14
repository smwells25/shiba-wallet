// Exercises the staking glue (src/wallet/staking.ts, phase 18 item 2;
// docs/STAKING.md) entirely OFFLINE against a fake node that emulates the
// read-only surface of Lido (stETH, wstETH, the withdrawal queue, the
// locator, the accounting oracle and its HashConsensus) and Rocket Pool
// (RocketStorage, the deposit settings, the deposit pool, rETH), the fake
// Kernel node and bundler of fakes-kernel.mjs, and the REAL send paths
// (prepareEvmSend / sendEvm and prepareAaCalls / sendAa). Covered: the
// readiness gate (mainnet refused before any request), what is offered on
// which network, the availability rules (Sepolia "deprecated, no rewards",
// unstaking refused after a LIVE isPaused() read, paused staking, the stake
// limit, a wrong deployment), every refusal, the quote shapes (raw
// transactions decoded with ethers; the smart-account batch decoded from
// the submitted UserOperation), the Hoodi smart-account refusal, and
// mutation checks for the pause check, the mainnet gate, the Hoodi Kernel
// refusal and the exact approval.
//
// Hoodi: the Hoodi checks run when the wallet has a BUILT-IN Hoodi profile
// (another phase 18 slice adds it); otherwise they check that Hoodi is
// refused and say so.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-staking.mjs
//
// The signing keys derive from the standard BIP-39 test mnemonic
// ("abandon … about"), which is public knowledge.

import { ethers } from 'ethers';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  KERNEL_V3_3,
  LIDO_DEPLOYMENTS,
  ROCKET_POOL_DEPLOYMENTS,
  rocketContractAddressKey,
  rocketProtocolSettingKey,
  rethBurnCall,
  rocketUserDepositBlockKey,
  toHex,
} from '@shiba-wallet/chains-evm';
const rethBurnCallFor = (amount) => rethBurnCall(ROCKET_POOL_DEPLOYMENTS['eip155:560048'].rETH, amount);
import {
  HOODI_NO_SMART_ACCOUNT,
  LIDO_RISK_STATEMENT,
  ROCKET_POOL_RISK_STATEMENT,
  SEPOLIA_UNSTAKE_PAUSED,
  STAKING_HOODI,
  STAKING_SEPOLIA,
  STETH_REBASING_NOTE,
  StakingRefusal,
  lidoHonestyLine,
  planStakingAction,
  prepareStakingAa,
  prepareStakingSend,
  previewStakingPlan,
  readLidoAvailability,
  readRocketPoolAvailability,
  readStakingBalances,
  stakingActionTitle,
  stakingBalancesHolderLine,
  stakingOfferFor,
  stakingSmartAccountRefusal,
  stakingSuccessBalanceNote,
  stakingSummaryLines,
  rethDepositLockNote,
  stakeOutcomeSimulatedLines,
  utcDate,
} from '../src/wallet/staking.ts';
import { GasEstimateRevertError, describeSendError, sendEvm } from '../src/wallet/send.ts';
import { describeAssetChanges } from '../src/wallet/simulation.ts';
import { createAaClientFromConfig, sendAa } from '../src/wallet/aa.ts';
import { featureReadiness, isFeatureAllowed, isTestNetwork } from '../src/config/readiness.ts';
import { isBuiltInEvmChain, setCustomEvmProfiles } from '../src/config/evm-chain.ts';
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

// Mutation checks load a deliberately broken copy of src/wallet/staking.ts
// from a scratch directory (relative imports rewritten to the real files),
// the check-aa.mjs pattern. The directory is removed on exit.
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUTANT_DIR = join(dirname(fileURLToPath(import.meta.url)), `.mutants-staking-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
const STAKING_SOURCE = readFileSync(join(APP_ROOT, 'src/wallet/staking.ts'), 'utf8');
async function stakingMutant(from, to, all = false) {
  if (!STAKING_SOURCE.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const mutated = all ? STAKING_SOURCE.split(from).join(to) : STAKING_SOURCE.replace(from, to);
  const originalDir = join(APP_ROOT, 'src/wallet');
  const rewritten = mutated.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-staking.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// The fake staking node
// ---------------------------------------------------------------------------

const SEP = LIDO_DEPLOYMENTS[STAKING_SEPOLIA];
const HOO = LIDO_DEPLOYMENTS[STAKING_HOODI];
const RP = ROCKET_POOL_DEPLOYMENTS[STAKING_HOODI];
const LOCATOR = '0x' + 'a1'.repeat(20);
const ORACLE = '0x' + 'a2'.repeat(20);
const CONSENSUS = '0x' + 'a3'.repeat(20);
const DEPOSIT_POOL = '0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8';
const SETTINGS_DEPOSIT = '0x86B455e24A9B5541D7703d07A8CE634f0309d2D2';
const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
const WSTETH_RATE_NUM = 96n; // fake rate: 1 stETH = 0.96 wstETH
const RETH_RATE_NUM = 96n; // fake rate: 1 ETH = 0.96 rETH

const views = new ethers.Interface([
  'function symbol() view returns (string)',
  'function stETH() view returns (address)',
  'function getLidoLocator() view returns (address)',
  'function withdrawalQueue() view returns (address)',
  'function accountingOracle() view returns (address)',
  'function getLastProcessingRefSlot() view returns (uint256)',
  'function getConsensusContract() view returns (address)',
  'function getChainConfig() view returns (uint256, uint256, uint256)',
  'function isStakingPaused() view returns (bool)',
  'function getCurrentStakeLimit() view returns (uint256)',
  'function isPaused() view returns (bool)',
  'function getLastRequestId() view returns (uint256)',
  'function getLastFinalizedRequestId() view returns (uint256)',
  'function getLastCheckpointIndex() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function sharesOf(address) view returns (uint256)',
  'function getStETHByWstETH(uint256) view returns (uint256)',
  'function getWstETHByStETH(uint256) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function getWithdrawalRequests(address) view returns (uint256[])',
  'function getWithdrawalStatus(uint256[]) view returns (tuple(uint256,uint256,address,uint256,bool,bool)[])',
  'function findCheckpointHints(uint256[],uint256,uint256) view returns (uint256[])',
  'function getClaimableEther(uint256[],uint256[]) view returns (uint256[])',
  'function getAddress(bytes32) view returns (address)',
  'function getUint(bytes32) view returns (uint256)',
  'function getDepositEnabled() view returns (bool)',
  'function getMinimumDeposit() view returns (uint256)',
  'function getDepositFee() view returns (uint256)',
  'function getMaximumDepositAmount() view returns (uint256)',
  'function getExchangeRate() view returns (uint256)',
  'function getTotalCollateral() view returns (uint256)',
  'function getRethValue(uint256) view returns (uint256)',
  'function getEthValue(uint256) view returns (uint256)',
  'function submit(address) payable returns (uint256)',
  'function wrap(uint256) returns (uint256)',
  'function unwrap(uint256) returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function requestWithdrawals(uint256[],address) returns (uint256[])',
  'function claimWithdrawals(uint256[],uint256[])',
  'function deposit() payable',
  'function burn(uint256)',
]);
const writes = new Set(['submit', 'wrap', 'unwrap', 'approve', 'requestWithdrawals', 'claimWithdrawals', 'deposit', 'burn']);

function sepoliaState(over = {}) {
  return {
    chainIdHex: '0xaa36a7',
    lido: SEP,
    symbols: { stETH: 'stETH', wstETH: 'wstETH', queue: 'unstETH' },
    stakingPaused: false,
    stakeLimit: 150_000n * E18,
    queuePaused: true,
    lastRequestId: 0n,
    lastFinalized: 0n,
    lastCheckpoint: 0n,
    refSlot: 7_977_087n,
    chainConfig: [32n, 12n, 1_655_733_600n],
    balances: {}, // `${token}|${holder}` (lower case) → bigint
    shares: {},
    allowances: {}, // `${token}|${owner}|${spender}` → bigint
    requests: {}, // owner (lower) → [{ id, amount, finalized, claimed }]
    hints: {}, // id → hint
    claimable: {}, // id → wei
    rocket: null,
    ethBalance: 5n * E18,
    blockNumber: 1000n,
    codeless: new Set(),
    revertOn: null, // a write function name whose eth_call reverts
    ...over,
  };
}

function hoodiState(over = {}) {
  return sepoliaState({
    chainIdHex: '0x88bb0',
    lido: HOO,
    stakeLimit: 3_000n * E18,
    queuePaused: false,
    lastRequestId: 5327n,
    lastFinalized: 5320n,
    lastCheckpoint: 1033n,
    refSlot: 4_118_367n,
    chainConfig: [32n, 12n, 1_742_213_400n],
    rocket: {
      depositEnabled: true,
      minimumDeposit: 10n ** 16n,
      depositFee: 5n * 10n ** 14n,
      maximumDepositAmount: 18_000n * E18,
      exchangeRate: 1_036_784_107_252_241_012n,
      totalCollateral: 1_336n * E18,
      delay: 5760n,
      userDepositBlock: {}, // holder (lower) → block
      rethInRegistry: RP.rETH,
    },
    ...over,
  });
}

function stakingNode(state) {
  const calls = [];
  const key = (...parts) => parts.map((p) => String(p).toLowerCase()).join('|');
  const transport = async (method, params) => {
    calls.push({ method, params });
    const s = state;
    switch (method) {
      case 'eth_chainId':
        return s.chainIdHex;
      case 'eth_getBalance':
        return '0x' + s.ethBalance.toString(16);
      case 'eth_getTransactionCount':
        return '0x3';
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: '0x' + GWEI.toString(16) };
      case 'eth_maxPriorityFeePerGas':
        return '0x' + GWEI.toString(16);
      case 'eth_estimateGas':
        return '0x' + (120_000).toString(16);
      case 'eth_blockNumber':
        return '0x' + s.blockNumber.toString(16);
      case 'eth_getCode':
        return s.codeless.has(params[0].toLowerCase()) ? '0x' : '0x6001';
      case 'eth_sendRawTransaction':
        transport.lastRaw = params[0];
        return '0x' + 'cd'.repeat(32);
      case 'eth_simulateV1': {
        // One call (or a batch): report the ETH leaving and the token minted.
        const { calls: sim } = params[0].blockStateCalls[0];
        const pad = (a) => ethers.zeroPadValue(a, 32);
        const transfer = ethers.id('Transfer(address,address,uint256)');
        const out = sim.map((c) => {
          const logs = [];
          const value = BigInt(c.value ?? '0x0');
          if (value > 0n) {
            logs.push({ address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [transfer, pad(c.from), pad(c.to)], data: ethers.toBeHex(value, 32) });
            const minted = same(c.to, s.lido.stETH) ? value - 1n : (value * 96n) / 100n;
            const token = same(c.to, s.lido.stETH) ? s.lido.stETH : same(c.to, s.lido.wstETH) ? s.lido.wstETH : RP.rETH;
            logs.push({ address: token, topics: [transfer, pad(ethers.ZeroAddress), pad(c.from)], data: ethers.toBeHex(minted, 32) });
          }
          return { status: '0x1', returnData: '0x', gasUsed: '0x1', logs };
        });
        return [{ calls: out }];
      }
      case 'eth_call': {
        const { to, data = '0x', from } = params[0];
        if (data === '0x' || data === undefined) {
          if (same(to, s.lido.wstETH)) return '0x';
          throw new Error(`fake staking node: unexpected plain call to ${to}`);
        }
        const tx = views.parseTransaction({ data });
        if (!tx) throw new Error(`fake staking node: unknown selector ${data.slice(0, 10)} to ${to}`);
        const name = tx.name;
        const enc = (...values) => views.encodeFunctionResult(tx.fragment, values);
        if (writes.has(name)) {
          if (s.revertOn === name) {
            const err = new Error('execution reverted: REVERTED_BY_FAKE');
            err.data = '0x08c379a0' + ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['REVERTED_BY_FAKE']).slice(2);
            throw err;
          }
          void from;
          return name === 'approve' ? enc(true) : name === 'claimWithdrawals' || name === 'deposit' || name === 'burn' ? '0x' : name === 'requestWithdrawals' ? enc([1n]) : enc(1n);
        }
        const isS = same(to, s.lido.stETH);
        const isW = same(to, s.lido.wstETH);
        const isQ = same(to, s.lido.withdrawalQueue);
        switch (name) {
          case 'symbol':
            if (isS) return enc(s.symbols.stETH);
            if (isW) return enc(s.symbols.wstETH);
            if (isQ) return enc(s.symbols.queue);
            if (same(to, RP.rETH)) return enc('rETH');
            break;
          case 'stETH':
            if (isW) return enc(s.lido.stETH);
            break;
          case 'getLidoLocator':
            if (isS) return enc(LOCATOR);
            break;
          case 'withdrawalQueue':
            if (same(to, LOCATOR)) return enc(s.lido.withdrawalQueue);
            break;
          case 'accountingOracle':
            if (same(to, LOCATOR)) return enc(ORACLE);
            break;
          case 'getLastProcessingRefSlot':
            if (same(to, ORACLE)) return enc(s.refSlot);
            break;
          case 'getConsensusContract':
            if (same(to, ORACLE)) return enc(CONSENSUS);
            break;
          case 'getChainConfig':
            if (same(to, CONSENSUS)) return enc(...s.chainConfig);
            break;
          case 'isStakingPaused':
            if (isS) return enc(s.stakingPaused);
            break;
          case 'getCurrentStakeLimit':
            if (isS) return enc(s.stakeLimit);
            break;
          case 'isPaused':
            if (isQ) {
              transport.isPausedReads = (transport.isPausedReads ?? 0) + 1;
              return enc(s.queuePaused);
            }
            break;
          case 'getLastRequestId':
            if (isQ) return enc(s.lastRequestId);
            break;
          case 'getLastFinalizedRequestId':
            if (isQ) return enc(s.lastFinalized);
            break;
          case 'getLastCheckpointIndex':
            if (isQ) return enc(s.lastCheckpoint);
            break;
          case 'balanceOf':
            return enc(s.balances[key(to, tx.args[0])] ?? 0n);
          case 'sharesOf':
            return enc(s.shares[key(to, tx.args[0])] ?? 0n);
          case 'getStETHByWstETH':
            return enc((tx.args[0] * 100n) / WSTETH_RATE_NUM);
          case 'getWstETHByStETH':
            return enc((tx.args[0] * WSTETH_RATE_NUM) / 100n);
          case 'allowance':
            return enc(s.allowances[key(to, tx.args[0], tx.args[1])] ?? 0n);
          case 'getWithdrawalRequests':
            if (isQ) return enc((s.requests[tx.args[0].toLowerCase()] ?? []).map((r) => r.id));
            break;
          case 'getWithdrawalStatus':
            if (isQ) {
              const all = Object.entries(s.requests).flatMap(([owner, list]) => list.map((r) => ({ ...r, owner })));
              return enc(tx.args[0].map((id) => {
                const r = all.find((x) => x.id === id);
                return [r.amount, r.amount, ethers.getAddress(r.owner), 1_700_000_000n, r.finalized, r.claimed];
              }));
            }
            break;
          case 'findCheckpointHints':
            if (isQ) {
              transport.hintRange = [tx.args[1], tx.args[2]];
              return enc(tx.args[0].map((id) => s.hints[String(id)] ?? 0n));
            }
            break;
          case 'getClaimableEther':
            if (isQ) return enc(tx.args[0].map((id) => s.claimable[String(id)] ?? 0n));
            break;
          case 'getAddress':
            if (same(to, RP.storage) && s.rocket) {
              const k = tx.args[0];
              if (k === toHex(rocketContractAddressKey('rocketDepositPool'))) return enc(DEPOSIT_POOL);
              if (k === toHex(rocketContractAddressKey('rocketTokenRETH'))) return enc(s.rocket.rethInRegistry);
              if (k === toHex(rocketContractAddressKey('rocketDAOProtocolSettingsDeposit'))) return enc(SETTINGS_DEPOSIT);
              return enc(ethers.ZeroAddress);
            }
            break;
          case 'getUint':
            if (same(to, RP.storage) && s.rocket) {
              const k = tx.args[0];
              if (k === toHex(rocketProtocolSettingKey('network', 'network.reth.deposit.delay'))) return enc(s.rocket.delay);
              for (const [holder, block] of Object.entries(s.rocket.userDepositBlock)) {
                if (k === toHex(rocketUserDepositBlockKey(holder))) return enc(block);
              }
              return enc(0n);
            }
            break;
          case 'getDepositEnabled':
            if (same(to, SETTINGS_DEPOSIT)) return enc(s.rocket.depositEnabled);
            break;
          case 'getMinimumDeposit':
            if (same(to, SETTINGS_DEPOSIT)) return enc(s.rocket.minimumDeposit);
            break;
          case 'getDepositFee':
            if (same(to, SETTINGS_DEPOSIT)) return enc(s.rocket.depositFee);
            break;
          case 'getMaximumDepositAmount':
            if (same(to, DEPOSIT_POOL)) return enc(s.rocket.maximumDepositAmount);
            break;
          case 'getExchangeRate':
            if (same(to, RP.rETH)) return enc(s.rocket.exchangeRate);
            break;
          case 'getTotalCollateral':
            if (same(to, RP.rETH)) return enc(s.rocket.totalCollateral);
            break;
          case 'getRethValue':
            if (same(to, RP.rETH)) return enc((tx.args[0] * RETH_RATE_NUM) / 100n);
            break;
          case 'getEthValue':
            if (same(to, RP.rETH)) return enc((tx.args[0] * 100n) / RETH_RATE_NUM);
            break;
        }
        throw new Error(`fake staking node: unexpected ${name} on ${to}`);
      }
      default:
        throw new Error(`fake staking node: unexpected method ${method}`);
    }
  };
  transport.calls = calls;
  return transport;
}

// The EOA paths build fetch-based transports from a URL; route them here.
const RPC_URL = 'https://staking-node.example/rpc';
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
const EOA = owner.address;
const NOW = 1_791_640_000n; // 2026-10-10 about 14:13 UTC
const HOODI_BUILT_IN = isBuiltInEvmChain(STAKING_HOODI) && isTestNetwork(STAKING_HOODI);

// ---------------------------------------------------------------------------
console.log('check-staking: readiness and what is offered where');
// ---------------------------------------------------------------------------
{
  const row = featureReadiness('staking');
  check('readiness row "staking" is testnet-only and enforced', row.status === 'testnet-only' && row.enforced === true);
  check('the row names its evidence (W1, W2, W9, W13) and a plain two-sentence reason', ['W1', 'W2', 'W9', 'W13'].every((i) => row.evidence.includes(i)) && row.reason.split(/(?<=\.)\s+/).length === 2, row.reason);
  check('staking is refused on mainnet and allowed on Sepolia', !isFeatureAllowed('staking', 'eip155:1') && isFeatureAllowed('staking', STAKING_SEPOLIA));

  fetchCount = 0;
  const e = await rejection(() => stakingOfferFor('eip155:1'));
  check('stakingOfferFor(mainnet) throws the readiness refusal', e?.name === 'FeatureNotAllowedError', String(e));
  const node = stakingNode(sepoliaState());
  const p = await rejection(() => planStakingAction(node, 'eip155:1', EOA, { kind: 'stake', protocol: 'lido', receive: 'stETH', amount: E18 }, 'ETH'));
  check('planStakingAction(mainnet) is refused with ZERO node requests', p?.name === 'FeatureNotAllowedError' && node.calls.length === 0, `${p} / ${node.calls.length}`);
  const fakePlan = { caip2: 'eip155:1', holder: EOA, main: { to: SEP.stETH, value: 1n, data: new Uint8Array() }, calls: [], approval: null };
  const q = await rejection(() => prepareStakingSend(RPC_URL, EOA, fakePlan));
  check('prepareStakingSend(mainnet plan) is refused with ZERO fetches', q?.name === 'FeatureNotAllowedError' && fetchCount === 0, `${q} / ${fetchCount}`);
  const aaNode = stakingNode(sepoliaState());
  const aaBundler = fakeBundler();
  const a = await rejection(() => prepareStakingAa({ chainId: 1n, node: aaNode, bundler: aaBundler }, EOA, fakePlan));
  check('prepareStakingAa(mainnet plan) is refused with zero node and bundler calls', a?.name === 'FeatureNotAllowedError' && aaNode.calls.length === 0 && aaBundler.calls.length === 0);

  const sep = stakingOfferFor(STAKING_SEPOLIA);
  check('Sepolia: Lido offered (the pinned deployment), no Rocket Pool, smart account allowed', sep.lido === SEP && sep.rocketPool === null && sep.smartAccountRefusal === null && sep.unavailable === null);
  const base = stakingOfferFor('eip155:84532');
  check('Base Sepolia: nothing offered, with a plain sentence naming where staking is', base.lido === null && base.rocketPool === null && /Ethereum Sepolia \(Lido, staking only\)/.test(base.unavailable ?? ''), base.unavailable);
  check('the Hoodi smart-account refusal is the exact sentence, whatever the profile', stakingSmartAccountRefusal(STAKING_HOODI) === HOODI_NO_SMART_ACCOUNT);
  check('a network without verified Kernel contracts refuses the smart account', /verified the Kernel/.test(stakingSmartAccountRefusal('eip155:999999') ?? ''));
  if (HOODI_BUILT_IN) {
    const h = stakingOfferFor(STAKING_HOODI);
    check('Hoodi (built-in profile present): Lido and Rocket Pool offered, smart account refused', h.lido === HOO && h.rocketPool === RP && h.smartAccountRefusal === HOODI_NO_SMART_ACCOUNT);
    check('…and the "where" sentence now names Hoodi', /Hoodi \(Lido and Rocket Pool\)/.test(base.unavailable ?? ''));
  } else {
    console.log('  (no built-in Hoodi profile in this tree: checking that Hoodi is refused)');
    check('Hoodi without a built-in profile: refused by the readiness gate', (await rejection(() => stakingOfferFor(STAKING_HOODI)))?.name === 'FeatureNotAllowedError');
    // A user-added Hoodi marked as a test network is a test network, but the
    // pinned addresses are offered only on built-in profiles.
    setCustomEvmProfiles([{ ...(await import('../src/config/evm-chain.ts')).EVM_SEPOLIA, caip2: STAKING_HOODI, chainIdDecimal: '560048', label: 'My Hoodi', kernelV33Verified: false, custom: { testnetRequested: true, symbol: 'ETH', explorer: null, blockTimeMs: 12000 } }]);
    const custom = stakingOfferFor(STAKING_HOODI);
    check('a user-added Hoodi is offered nothing (built-in profiles only)', custom.lido === null && custom.rocketPool === null && custom.unavailable !== null);
    setCustomEvmProfiles([]);
  }
}

// ---------------------------------------------------------------------------
console.log('check-staking: Lido availability on Sepolia (deprecated, no rewards, unstaking paused)');
// ---------------------------------------------------------------------------
{
  const node = stakingNode(sepoliaState());
  const av = await readLidoAvailability(node, STAKING_SEPOLIA, NOW);
  check('no deployment problems with the expected symbols, wrapper and locator', av.problems.length === 0, av.problems.join(' '));
  check('the oracle report time is 2 July 2025 (slot 7,977,087 × 12 s + genesis)', utcDate(av.state.oracleLastReportTime) === '2 July 2025');
  check('the honesty line says deprecated AND no rewards since 2 July 2025',
    av.honestyLine === 'Lido calls its deployment on this network deprecated. Test stETH here does not earn rewards: Lido’s oracle has not reported since 2 July 2025.', av.honestyLine);
  check('staking is open; unstaking refused with the Sepolia sentence after a live isPaused() read',
    av.stakeRefusal === null && av.unstakeRefusal === SEPOLIA_UNSTAKE_PAUSED && node.isPausedReads === 1);
  check('the Lido risk statement is quoted with its source URL and date', LIDO_RISK_STATEMENT.sentences.length === 4 && LIDO_RISK_STATEMENT.url.startsWith('https://help.lido.fi/') && LIDO_RISK_STATEMENT.read === '2026-10-11' && LIDO_RISK_STATEMENT.sentences[2] === 'ETH validators risk staking penalties, with up to 100% of staked funds at risk if validators fail.');
  check('the Rocket Pool statement says its documentation has no risk page and quotes its FAQ', /no page on the risks/.test(ROCKET_POOL_RISK_STATEMENT.intro) && ROCKET_POOL_RISK_STATEMENT.url === 'https://docs.rocketpool.net/protocol/faq');

  const paused = await readLidoAvailability(stakingNode(sepoliaState({ stakingPaused: true })), STAKING_SEPOLIA, NOW);
  check('paused staking is refused in plain words', /staking paused/.test(paused.stakeRefusal ?? ''));
  const wrong = await readLidoAvailability(stakingNode(sepoliaState({ symbols: { stETH: 'stETH', wstETH: 'FAKE', queue: 'unstETH' } })), STAKING_SEPOLIA, NOW);
  check('a wrong deployment refuses every Lido action with the reason', wrong.problems.length === 1 && /not what the wallet expects/.test(wrong.stakeRefusal) && wrong.stakeRefusal === wrong.unstakeRefusal);
  const nocode = await readLidoAvailability(stakingNode(sepoliaState({ codeless: new Set([SEP.withdrawalQueue.toLowerCase()]) })), STAKING_SEPOLIA, NOW);
  check('a missing contract is reported, not read', /No contract code at Lido's withdrawal queue/.test(nocode.problems[0] ?? ''));
  check('an active deployment with a recent report has no honesty line', lidoHonestyLine(HOO, NOW - 3600n, NOW) === null);
  check('an active deployment whose oracle is silent for over 7 days says no rewards, without "deprecated"',
    /does not earn rewards/.test(lidoHonestyLine(HOO, NOW - 8n * 86400n, NOW) ?? '') && !/deprecated/.test(lidoHonestyLine(HOO, NOW - 8n * 86400n, NOW) ?? ''));
}

// ---------------------------------------------------------------------------
console.log('check-staking: Sepolia plans and their refusals');
// ---------------------------------------------------------------------------
const stakeAction = (amount, receive = 'stETH') => ({ kind: 'stake', protocol: 'lido', receive, amount });
{
  const node = stakingNode(sepoliaState());
  const plan = await planStakingAction(node, STAKING_SEPOLIA, EOA, stakeAction(10n ** 15n), 'test ETH');
  check('stake → stETH: one call, submit(address(0)) with the value, to Lido’s stETH',
    plan.calls.length === 1 && same(plan.main.to, SEP.stETH) && plan.main.value === 10n ** 15n && toHex(plan.main.data) === '0xa1903eab' + '0'.repeat(64));
  check('…the honesty line travels with the plan, and stETH carries the rebasing flag', plan.notes[0]?.startsWith('Lido calls its deployment') && plan.rebasing === true);
  check('…summary lines are exact and marked approximate where they are an estimate',
    JSON.stringify(stakingSummaryLines(plan)) === JSON.stringify(['You send 0.001 test ETH', 'You receive ≈ 0.001 stETH']), JSON.stringify(stakingSummaryLines(plan)));
  const w = await planStakingAction(node, STAKING_SEPOLIA, EOA, stakeAction(10n ** 15n, 'wstETH'), 'test ETH');
  check('stake → wstETH: a plain transfer to wstETH (no calldata), receive = getWstETHByStETH', same(w.main.to, SEP.wstETH) && w.main.data.length === 0 && w.youReceive.amount === (10n ** 15n * 96n) / 100n && w.rebasing === false);

  const refusals = [
    ['zero amount', stakeAction(0n), /greater than zero/],
    ['above the stake limit', stakeAction(150_001n * E18), /above Lido’s current stake limit/],
    ['wrap without stETH', { kind: 'wrap', amount: 5n }, /more stETH than this account holds/],
    ['unwrap without wstETH', { kind: 'unwrap', amount: 5n }, /more wstETH than this account holds/],
    ['unstake on Sepolia (queue paused, read live)', { kind: 'unstake', amount: 10n ** 15n }, /^Unstaking through Lido is paused on Sepolia/],
    ['Rocket Pool on Sepolia', { kind: 'stake', protocol: 'rocket-pool', amount: E18 }, /No staking protocol|Rocket Pool is not offered/],
    ['rETH burn on Sepolia', { kind: 'burn', amount: E18 }, /No staking protocol|Rocket Pool is not offered/],
  ];
  for (const [name, action, pattern] of refusals) {
    const e = await rejection(() => planStakingAction(stakingNode(sepoliaState()), STAKING_SEPOLIA, EOA, action, 'test ETH'));
    check(`refused: ${name} (a StakingRefusal with a plain sentence)`, e instanceof StakingRefusal && pattern.test(e.message), String(e));
  }
  const paused = await rejection(() => planStakingAction(stakingNode(sepoliaState({ stakingPaused: true })), STAKING_SEPOLIA, EOA, stakeAction(1n), 'ETH'));
  check('refused: stake while Lido has staking paused', paused instanceof StakingRefusal && /staking paused/.test(paused.message));
  const wrongChain = await rejection(() => planStakingAction(stakingNode(sepoliaState({ chainIdHex: '0x1' })), STAKING_SEPOLIA, EOA, stakeAction(1n), 'ETH'));
  check('refused: an endpoint on another chain', wrongChain instanceof StakingRefusal && /chain id 1, not the network/.test(wrongChain.message));
  const unstakeNode = stakingNode(sepoliaState());
  await rejection(() => planStakingAction(unstakeNode, STAKING_SEPOLIA, EOA, { kind: 'unstake', amount: 10n ** 15n }, 'ETH'));
  check('the Sepolia unstake refusal followed a live isPaused() read of the queue', unstakeNode.isPausedReads === 1);
}

// ---------------------------------------------------------------------------
console.log('check-staking: regular-account quotes through the real prepareEvmSend / sendEvm');
// ---------------------------------------------------------------------------
{
  const st = sepoliaState();
  fetchNode = stakingNode(st);
  const plan = await planStakingAction(fetchNode, STAKING_SEPOLIA, EOA, stakeAction(10n ** 15n), 'test ETH');
  const q = await prepareStakingSend(RPC_URL, EOA, plan);
  check('stake quote: step main, to stETH, value, submit calldata, pre-flight passed',
    q.step === 'main' && same(q.quote.to, SEP.stETH) && q.quote.amount === 10n ** 15n && toHex(q.quote.data) === toHex(plan.main.data) && q.quote.simulation.ok === true);
  check('…fee = gas × max fee (120,000 × 3 gwei) and total = value + fee', q.quote.fee === 120_000n * 3n * GWEI && q.quote.total === 10n ** 15n + q.quote.fee);
  await sendEvm(RPC_URL, owner, q.quote, 'https://sepolia.etherscan.io/tx/');
  const tx = ethers.Transaction.from(fetchNode.lastRaw);
  check('the signed transaction (decoded by ethers) is exactly the staking call on chain 11155111',
    tx.chainId === 11155111n && same(tx.to, SEP.stETH) && tx.value === 10n ** 15n && tx.data === toHex(plan.main.data) && same(tx.from, EOA));

  const wq = await prepareStakingSend(RPC_URL, EOA, await planStakingAction(fetchNode, STAKING_SEPOLIA, EOA, stakeAction(10n ** 15n, 'wstETH'), 'ETH'));
  check('stake → wstETH quote: a plain transfer to wstETH, no data', wq.step === 'main' && same(wq.quote.to, SEP.wstETH) && wq.quote.data === undefined && wq.quote.amount === 10n ** 15n);

  st.balances[`${SEP.stETH.toLowerCase()}|${EOA.toLowerCase()}`] = 5n * 10n ** 15n;
  const wrapPlan = await planStakingAction(fetchNode, STAKING_SEPOLIA, EOA, { kind: 'wrap', amount: 2n * 10n ** 15n }, 'ETH');
  const approve = await prepareStakingSend(RPC_URL, EOA, wrapPlan);
  const approveData = new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [SEP.wstETH, 2n * 10n ** 15n]);
  check('wrap without an allowance → step approve: EXACTLY the amount to wstETH, on stETH, value 0',
    approve.step === 'approve' && same(approve.quote.to, SEP.stETH) && approve.quote.amount === 0n && toHex(approve.quote.data) === approveData && approve.allowance === 0n);
  st.allowances[`${SEP.stETH.toLowerCase()}|${EOA.toLowerCase()}|${SEP.wstETH.toLowerCase()}`] = 2n * 10n ** 15n;
  const wrapMain = await prepareStakingSend(RPC_URL, EOA, wrapPlan);
  check('with the allowance in place → step main: wrap(amount) on wstETH', wrapMain.step === 'main' && same(wrapMain.quote.to, SEP.wstETH) && toHex(wrapMain.quote.data) === toHex(wrapPlan.main.data));

  st.revertOn = 'submit';
  const reverting = await prepareStakingSend(RPC_URL, EOA, plan);
  check('a reverting call is quoted with a FAILED pre-flight (the screen blocks the send)', reverting.quote.simulation.ok === false && /REVERTED_BY_FAKE/.test(reverting.quote.simulation.reason), JSON.stringify(reverting.quote.simulation));
  st.revertOn = null;

  const other = await rejection(() => prepareStakingSend(RPC_URL, '0x' + '12'.repeat(20), plan));
  check('a plan read for another address is refused before any quote', other instanceof StakingRefusal && /another address/.test(other.message));

  const preview = await previewStakingPlan(fetchNode, plan);
  check('outcome preview: the ETH sent and the stETH minted (1 wei short), with the rebasing caveat',
    preview.ok && preview.sent === 10n ** 15n && preview.received.length === 1 && preview.received[0].symbol === 'stETH' && preview.received[0].amount === 10n ** 15n - 1n && preview.rebasingCaveat === true);
  check('the rebasing note says 1 or 2 wei and that the figure comes from the token’s own event', /1 or 2 wei/.test(STETH_REBASING_NOTE) && /own event/.test(STETH_REBASING_NOTE));
  // Phase 19 item 4: the confirm said the rebasing caveat twice (the outcome
  // card's STETH_REBASING_NOTE and the preview row's REBASING_TOKEN_NOTE).
  // Both confirm previews now drop the short row note exactly when the
  // outcome card shows the fuller one (plan.rebasing).
  {
    const screen = readFileSync(join(APP_ROOT, 'src/screens/StakingScreen.tsx'), 'utf8');
    const views = readFileSync(join(APP_ROOT, 'src/screens/StakingViews.tsx'), 'utf8');
    const once = (src, viewsSrc) =>
      (src.match(/<BalanceChangePreview\b/g) ?? []).length === 2 &&
      [...src.matchAll(/<BalanceChangePreview\b((?:(?!\/>)[\s\S])*)\/>/g)].filter((m) => /\n\s*rowNotes=\{!plan\.rebasing\}\s*$/.test(m[1])).length === 2 &&
      viewsSrc.includes('{plan.rebasing ? <Text style={[styles.hint, { color: theme.textMuted }]}>{STETH_REBASING_NOTE}</Text> : null}');
    check('the stETH confirm says the rebasing caveat once: both previews pass rowNotes={!plan.rebasing}, the outcome card keeps the fuller note (source)', once(screen, views));
    check('…the old screen (the preview with its row note on a stETH plan) fails the check', !once(screen.replaceAll('\n          rowNotes={!plan.rebasing}', ''), views));
    check('…a screen that drops the outcome card\'s note fails the check', !once(screen, views.replace('{plan.rebasing ? <Text', '{false ? <Text')));
    const quiet = describeAssetChanges(
      [{ type: 'native', callIndex: 0, direction: 'out', from: EOA, to: SEP.stETH, amount: 10n ** 15n },
        { type: 'erc20', callIndex: 0, direction: 'in', token: SEP.stETH, from: '0x0000000000000000000000000000000000000000', to: EOA, amount: 10n ** 15n - 1n }],
      { [SEP.stETH.toLowerCase()]: { symbol: 'stETH', decimals: 18, tracked: true } },
      { nativeSymbol: 'test ETH', hidden: false, chainCaip2: 'eip155:11155111', rowNotes: false },
    );
    check('…what that preview then renders for the live stake: the two rows, no row note',
      JSON.stringify(quiet) === JSON.stringify([{ text: 'You send 0.001 test ETH', tone: 'out' }, { text: 'You receive 0.000999999999999999 stETH', tone: 'in' }]), quiet);
  }
  check('the device prompt names the action exactly', stakingActionTitle(plan.action, 'test ETH') === 'Stake 0.001 test ETH with Lido for stETH', stakingActionTitle(plan.action, 'test ETH'));
  fetchNode = null;
}

// ---------------------------------------------------------------------------
console.log('check-staking: smart-account quotes through the real prepareAaCalls / sendAa (Sepolia)');
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
  chain: STAKING_SEPOLIA,
  eip7702Owners: [],
  recoveredAccounts: [],
  bundlerUrlIgnoredReason: null,
  paymasterUrlIgnoredReason: null,
};
function sepoliaBundle(state) {
  const staking = stakingNode(state);
  const kernel = fakeKernelNode({ chainIdHex: '0xaa36a7', balance: E18 });
  const stakingAddresses = [SEP.stETH, SEP.wstETH, SEP.withdrawalQueue, LOCATOR, ORACLE, CONSENSUS].map((a) => a.toLowerCase());
  const node = async (method, params) => {
    if (method === 'eth_call' && stakingAddresses.includes(String(params[0].to).toLowerCase())) return staking(method, params);
    if (method === 'eth_getCode' && stakingAddresses.includes(String(params[0]).toLowerCase())) return staking(method, params);
    if (method === 'eth_simulateV1') return staking(method, params);
    return kernel(method, params);
  };
  const bundler = fakeBundler();
  const bundle = createAaClientFromConfig(kernelConfig, {
    nodeUrl: 'https://node.example',
    chainId: 11155111n,
    accountIndex: 0,
    ownerAddress: OWNER_0,
    transportFor: (url) => (url === 'https://node.example' ? node : bundler),
  });
  return { bundle, bundler, staking };
}
{
  const st = sepoliaState();
  const { bundle, bundler } = sepoliaBundle(st);
  const plan = await planStakingAction(bundle.node, STAKING_SEPOLIA, KERNEL_ACCOUNT_0, stakeAction(10n ** 15n), 'test ETH');
  const quote = await prepareStakingAa(bundle, OWNER_0, plan);
  check('smart-account stake: one call, the same submit call, sender = the Kernel account',
    quote.calls.length === 1 && same(quote.calls[0].to, SEP.stETH) && quote.calls[0].value === 10n ** 15n && same(quote.sender, KERNEL_ACCOUNT_0));
  await sendAa(bundle, owner, quote);
  const exec = decodeKernelExecute(bundler.lastOp.callData);
  check('the submitted UserOperation executes exactly submit(address(0)) with the value', exec.calls.length === 1 && same(exec.calls[0].to, SEP.stETH) && exec.calls[0].value === 10n ** 15n && exec.calls[0].data === toHex(plan.main.data));

  st.balances[`${SEP.stETH.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`] = 5n * 10n ** 15n;
  const second = sepoliaBundle(st);
  const wrapPlan = await planStakingAction(second.bundle.node, STAKING_SEPOLIA, KERNEL_ACCOUNT_0, { kind: 'wrap', amount: 10n ** 15n }, 'ETH');
  const wq = await prepareStakingAa(second.bundle, OWNER_0, wrapPlan);
  check('smart-account wrap: ONE operation with [approve(wstETH, exact), wrap(amount)]',
    wq.calls.length === 2 && same(wq.calls[0].to, SEP.stETH) && toHex(wq.calls[0].data) === toHex(wrapPlan.calls[0].data) && same(wq.calls[1].to, SEP.wstETH) && wq.tokenSpend?.amount === 10n ** 15n);
  await sendAa(second.bundle, owner, wq);
  const batch = decodeKernelExecute(second.bundler.lastOp.callData);
  check('…submitted as a batch of exactly those two calls', batch.calls.length === 2 && batch.calls[1].data === toHex(wrapPlan.main.data));

  const mismatch = await rejection(() => prepareStakingAa(sepoliaBundle(sepoliaState()).bundle, OWNER_0, { ...plan, holder: EOA }));
  check('a plan read for the owner EOA is refused for the smart account', mismatch instanceof StakingRefusal && /another address than the smart account/.test(mismatch.message));
}

// ---------------------------------------------------------------------------
console.log('check-staking: Hoodi (Lido in full, Rocket Pool, no smart account)');
// ---------------------------------------------------------------------------
const HOODI_PLAN = { caip2: STAKING_HOODI, holder: EOA, main: { to: HOO.stETH, value: 1n, data: new Uint8Array() }, calls: [{ to: HOO.stETH, value: 1n, data: new Uint8Array() }], approval: null, tokenOutflow: null, youSend: null };
async function hoodiAaAttempt(mod) {
  const node = stakingNode(hoodiState());
  const bundler = fakeBundler({ chainIdHex: '0x88bb0' });
  const e = await rejection(() => mod.prepareStakingAa({ chainId: 560048n, node, bundler, client: {}, accountType: 'kernel-v3.3' }, OWNER_0, HOODI_PLAN));
  return { e, requests: node.calls.length + bundler.calls.length };
}
if (HOODI_BUILT_IN) {
  const st = hoodiState();
  const node = stakingNode(st);
  const av = await readLidoAvailability(node, STAKING_HOODI, NOW);
  check('Hoodi Lido: no problems, open queue, report on 10 October 2026, no honesty line', av.problems.length === 0 && av.unstakeRefusal === null && utcDate(av.state.oracleLastReportTime) === '10 October 2026' && av.honestyLine === null);
  const rp = await readRocketPoolAvailability(node, STAKING_HOODI);
  check('Rocket Pool resolved from RocketStorage: the deposit pool and settings, rETH as pinned', same(rp.contracts.depositPool, DEPOSIT_POOL) && same(rp.contracts.rETH, RP.rETH) && rp.depositRefusal === null && rp.state.depositDelayBlocks === 5760n);

  const { e, requests } = await hoodiAaAttempt({ prepareStakingAa });
  check('smart-account staking on Hoodi is refused with the exact sentence and zero requests', e instanceof StakingRefusal && e.message === HOODI_NO_SMART_ACCOUNT && requests === 0, `${e} / ${requests}`);

  // Unstake on Hoodi: approve + requestWithdrawals, owner = the account.
  st.balances[`${HOO.stETH.toLowerCase()}|${EOA.toLowerCase()}`] = 10n ** 16n;
  const req = await planStakingAction(node, STAKING_HOODI, EOA, { kind: 'unstake', amount: 10n ** 15n }, 'test ETH');
  const reqAbi = new ethers.Interface(['function requestWithdrawals(uint256[],address)', 'function approve(address,uint256)']);
  check('unstake on Hoodi: [approve(queue, exact), requestWithdrawals([amount], the account)] with the cannot-cancel note',
    req.calls.length === 2 && toHex(req.calls[0].data) === reqAbi.encodeFunctionData('approve', [HOO.withdrawalQueue, 10n ** 15n]) && toHex(req.main.data) === reqAbi.encodeFunctionData('requestWithdrawals', [[10n ** 15n], EOA]) && req.notes.some((n) => /cannot be cancelled/.test(n)));
  check('…its summary says a request NFT is received, not ETH', stakingSummaryLines(req).at(-1) === 'You receive a withdrawal request (an NFT) to claim the ETH later.');
  const tiny = await rejection(() => planStakingAction(node, STAKING_HOODI, EOA, { kind: 'unstake', amount: 99n }, 'ETH'));
  check('refused: a request below Lido’s 100-wei minimum', tiny instanceof StakingRefusal && /at least 100 wei/.test(tiny.message));
  const queuePaused = await rejection(() => planStakingAction(stakingNode(hoodiState({ queuePaused: true })), STAKING_HOODI, EOA, { kind: 'unstake', amount: 10n ** 15n }, 'ETH'));
  check('refused: unstake while Hoodi’s queue is paused (not the Sepolia sentence)', queuePaused instanceof StakingRefusal && /queue is paused on this network/.test(queuePaused.message) && !/Sepolia/.test(queuePaused.message));

  // Claim: finalized requests get hints from findCheckpointHints(ids, 1, last).
  st.requests[EOA.toLowerCase()] = [
    { id: 5321n, amount: 10n ** 15n, finalized: false, claimed: false },
    { id: 2388n, amount: 5n * 10n ** 15n, finalized: true, claimed: false },
    { id: 2387n, amount: 10n ** 15n, finalized: true, claimed: false },
  ];
  st.hints = { 2387: 542n, 2388: 542n };
  st.claimable = { 2387: 10n ** 15n, 2388: 5n * 10n ** 15n };
  const claim = await planStakingAction(node, STAKING_HOODI, EOA, { kind: 'claim' }, 'test ETH');
  const claimAbi = new ethers.Interface(['function claimWithdrawals(uint256[],uint256[])']);
  check('claim: only the finalized requests, ascending, with their hints (search range 1 … last checkpoint)',
    toHex(claim.main.data) === claimAbi.encodeFunctionData('claimWithdrawals', [[2387n, 2388n], [542n, 542n]]) && node.hintRange?.[0] === 1n && node.hintRange?.[1] === 1033n);
  check('…the ETH to receive is the sum of getClaimableEther', claim.youReceive.amount === 6n * 10n ** 15n && claim.youSend === null);
  st.requests[EOA.toLowerCase()] = [{ id: 5321n, amount: 10n ** 15n, finalized: false, claimed: false }];
  const nothing = await rejection(() => planStakingAction(node, STAKING_HOODI, EOA, { kind: 'claim' }, 'ETH'));
  check('claim with only a pending request: "still waiting in Lido’s queue"', nothing instanceof StakingRefusal && /still waiting in Lido’s queue/.test(nothing.message));
  st.hints = {};
  st.requests[EOA.toLowerCase()] = [{ id: 2387n, amount: 1n, finalized: true, claimed: false }];
  const noHint = await rejection(() => planStakingAction(node, STAKING_HOODI, EOA, { kind: 'claim' }, 'ETH'));
  check('a NOT_FOUND hint (0) for a request the wallet thought finalized is refused', /not finalized/.test(noHint?.message ?? ''), String(noHint));
  st.requests = {};

  // Rocket Pool deposit and burn.
  const dep = await planStakingAction(node, STAKING_HOODI, EOA, { kind: 'stake', protocol: 'rocket-pool', amount: 10n ** 16n }, 'test ETH');
  check('Rocket Pool deposit: deposit() with the value, to the deposit pool resolved from storage',
    same(dep.main.to, DEPOSIT_POOL) && dep.main.value === 10n ** 16n && toHex(dep.main.data) === '0xd0e30db0');
  check('…rETH expected = getRethValue(amount − fee) and the fee note is exact',
    dep.youReceive.amount === ((10n ** 16n - 5n * 10n ** 12n) * 96n) / 100n && dep.notes[0].includes('0.000005 test ETH'));
  const below = await rejection(() => planStakingAction(node, STAKING_HOODI, EOA, { kind: 'stake', protocol: 'rocket-pool', amount: 10n ** 16n - 1n }, 'ETH'));
  check('refused: below Rocket Pool’s minimum deposit', below instanceof StakingRefusal && /below Rocket Pool’s minimum/.test(below.message));
  const off = await rejection(() => planStakingAction(stakingNode(hoodiState({ rocket: { ...hoodiState().rocket, depositEnabled: false } })), STAKING_HOODI, EOA, { kind: 'stake', protocol: 'rocket-pool', amount: E18 }, 'ETH'));
  check('refused: Rocket Pool deposits switched off', off instanceof StakingRefusal && /switched off/.test(off.message));
  const liar = await rejection(() => planStakingAction(stakingNode(hoodiState({ rocket: { ...hoodiState().rocket, rethInRegistry: '0x' + '77'.repeat(20) } })), STAKING_HOODI, EOA, { kind: 'stake', protocol: 'rocket-pool', amount: E18 }, 'ETH'));
  check('refused: a registry whose rETH differs from the pinned one', /not the pinned/.test(liar?.message ?? ''), String(liar));

  st.balances[`${RP.rETH.toLowerCase()}|${EOA.toLowerCase()}`] = 10n ** 16n;
  st.rocket.userDepositBlock[EOA.toLowerCase()] = 900n; // block 1000 now, delay 5760 → locked until 6661
  const locked = await rejection(() => planStakingAction(node, STAKING_HOODI, EOA, { kind: 'burn', amount: 10n ** 15n }, 'ETH'));
  check('refused: an rETH burn inside the deposit lock, naming the first allowed block', locked instanceof StakingRefusal && /from block 6661/.test(locked.message), String(locked));
  st.rocket.userDepositBlock = {};
  const burn = await planStakingAction(node, STAKING_HOODI, EOA, { kind: 'burn', amount: 10n ** 15n }, 'test ETH');
  check('rETH burn: burn(amount) on rETH, the ETH value from getEthValue', same(burn.main.to, RP.rETH) && burn.youReceive.amount === (10n ** 15n * 100n) / 96n && burn.tokenOutflow.amount === 10n ** 15n);
  const balances = await readStakingBalances(node, STAKING_HOODI, EOA, rp);
  check('balances: stETH, rETH with its ETH value, the lock state', balances.lido.stETH === 10n ** 16n && balances.rETH === 10n ** 16n && balances.rethEthValue === (10n ** 16n * 100n) / 96n && balances.rethLock.locked === false);

  // Phase 20 item 0 finding 5: the deposit confirm's lock sentence was stale
  // given F-72 (the deployed Hoodi code never records a lock).
  const LOCK_NOTE_HOODI =
    'Rocket Pool’s rETH contract can refuse moving or redeeming rETH for up to 5,760 blocks after a deposit if a deposit lock is recorded for the address; in the deployed Hoodi code no lock was recorded in two live runs (a burn succeeded 20 blocks after the deposit), but the wallet still checks the stored lock before a burn.';
  check('the deposit confirm’s lock sentence is the accurate, conservative form (exact)', dep.notes[1] === LOCK_NOTE_HOODI && rethDepositLockNote(5760n, STAKING_HOODI) === LOCK_NOTE_HOODI, dep.notes[1]);
  check('…the stale "for 5760 blocks after a deposit; the wallet checks this before any redemption" form is gone',
    !dep.notes.some((n) => /for 5760 blocks after a deposit;/.test(n) || /checks this before any redemption/.test(n)));
  check('…elsewhere (no live record) it claims no Hoodi runs but still names the stored-lock check',
    rethDepositLockNote(5760n, 'eip155:999') === 'Rocket Pool’s rETH contract can refuse moving or redeeming rETH for up to 5,760 blocks after a deposit if a deposit lock is recorded for the address. The wallet checks the stored lock before a burn.');

  // Phase 20 item 0 finding 6: the outcome card listed only what ARRIVES.
  // Shapes of the live receipts (Hoodi, Account 1 → here the test EOA):
  // the burn (block 3,799,824: rETH Transfer holder → 0x0, then ETH from the
  // rETH contract) and the withdrawal request (block 3,799,852: Approval to 0,
  // stETH Transfer holder → queue, TransferShares, request NFT minted).
  const T = ethers.id('Transfer(address,address,uint256)');
  const A = ethers.id('Approval(address,address,uint256)');
  const pad = (a) => ethers.zeroPadValue(a, 32);
  const receiptNode = (logs) => async (method) => {
    if (method === 'eth_simulateV1') return [{ calls: [{ status: '0x1', returnData: '0x', gasUsed: '0x1', logs }] }];
    throw new Error(`unexpected ${method}`);
  };
  const BURN_RETH = 4_820_023_614_978_392n;
  const BURN_ETH = 4_997_499_999_999_999n;
  const burnLive = { ...burn, calls: [rethBurnCallFor(BURN_RETH)], main: rethBurnCallFor(BURN_RETH) };
  const burnPreview = await previewStakingPlan(receiptNode([
    { address: RP.rETH, topics: [T, pad(EOA), pad(ethers.ZeroAddress)], data: ethers.toBeHex(BURN_RETH, 32) },
    { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [T, pad(RP.rETH), pad(EOA)], data: ethers.toBeHex(BURN_ETH, 32) },
  ]), burnLive);
  const burnLines = stakeOutcomeSimulatedLines(burnPreview, 'test ETH');
  check('burn card: "Simulated: 0.004820023614978392 rETH leave (token contract 0x7322…)" first, then the ETH that arrives',
    burnLines.length === 2 &&
      burnLines[0] === `Simulated: 0.004820023614978392 rETH leave (token contract ${RP.rETH}).` &&
      burnLines[1] === 'Simulated: 0.004997499999999999 test ETH arrive.', burnLines.join(' | '));
  const REQ = 5n * 10n ** 15n;
  const reqLive = { ...req, calls: [req.main], approval: null };
  const reqPreview = await previewStakingPlan(receiptNode([
    { address: HOO.stETH, topics: [A, pad(EOA), pad(HOO.withdrawalQueue)], data: ethers.toBeHex(0n, 32) },
    { address: HOO.stETH, topics: [T, pad(EOA), pad(HOO.withdrawalQueue)], data: ethers.toBeHex(REQ, 32) },
    { address: HOO.withdrawalQueue, topics: [T, pad(ethers.ZeroAddress), pad(EOA), ethers.toBeHex(5329n, 32)], data: '0x' },
  ]), reqLive);
  const reqLines = stakeOutcomeSimulatedLines(reqPreview, 'test ETH');
  check('withdrawal-request card: "Simulated: 0.005 stETH leave (token contract 0x3508…)"',
    reqLines.length === 1 && reqLines[0] === `Simulated: 0.005 stETH leave (token contract ${HOO.stETH}).`, reqLines.join(' | '));
  const stakeLines = stakeOutcomeSimulatedLines({ ok: true, sent: 10n ** 16n, receivedNative: 0n, received: [{ token: HOO.stETH, symbol: 'stETH', decimals: 18, amount: 10n ** 16n - 1n }], spent: [], rebasingCaveat: true, skippedLogs: 0 }, 'test ETH');
  check('stake card: the ETH that leaves, then the stETH that arrives (unchanged wording for arrivals)',
    stakeLines.join(' | ') === `Simulated: 0.01 test ETH leave. | Simulated: 0.009999999999999999 stETH arrive (token contract ${HOO.stETH}).`, stakeLines.join(' | '));
  const viewsSrc = readFileSync(join(APP_ROOT, 'src/screens/StakingViews.tsx'), 'utf8');
  check('the outcome card renders stakeOutcomeSimulatedLines (no arrivals-only list left) (source)',
    /stakeOutcomeSimulatedLines\(preview, nativeSymbol\)\.map\(/.test(viewsSrc) && !/preview\.received\.map\(/.test(viewsSrc));
} else {
  const { e } = await hoodiAaAttempt({ prepareStakingAa });
  check('without a built-in Hoodi profile, a Hoodi smart-account plan is refused by the readiness gate', e?.name === 'FeatureNotAllowedError', String(e));
}

// ---------------------------------------------------------------------------
console.log('check-staking: a stake the account cannot afford says so (phase 18 emulator finding 1)');
// ---------------------------------------------------------------------------
{
  // A node that answers like geth: an estimate whose value exceeds the
  // balance fails for funds; Lido's submit() with value 0 reverts
  // ZERO_DEPOSIT and Rocket Pool's deposit() with value 0 reverts with its
  // minimum-deposit text (the two texts seen on the emulator).
  const withEstimates = (state) => {
    const base = stakingNode(state);
    const estimates = [];
    const node = async (method, params) => {
      if (method !== 'eth_estimateGas') return base(method, params);
      estimates.push(params[0]);
      const value = BigInt(params[0].value ?? '0x0');
      if (value > state.ethBalance) throw new Error('insufficient funds for transfer');
      if (value === 0n && same(params[0].to, state.lido.stETH)) throw new Error('execution reverted: ZERO_DEPOSIT');
      if (value === 0n) throw new Error('execution reverted: The deposited amount is less than the minimum deposit size');
      return '0x' + (120_000).toString(16);
    };
    node.estimates = estimates;
    return node;
  };
  const minFee = 21_000n * 3n * GWEI;
  const st = sepoliaState({ ethBalance: 10n ** 14n });
  fetchNode = withEstimates(st);
  const plan = await planStakingAction(fetchNode, STAKING_SEPOLIA, EOA, stakeAction(10n ** 15n), 'test ETH');
  const e = await rejection(() => prepareStakingSend(RPC_URL, EOA, plan));
  const d = describeSendError(e, 'test ETH');
  check('Lido stake above the balance → "Not enough test ETH to cover this amount plus the network fee." (not ZERO_DEPOSIT)',
    !(e instanceof GasEstimateRevertError) && d.title === 'Not enough test ETH to cover this amount plus the network fee.' && !/ZERO_DEPOSIT|revert/i.test(`${d.title} ${d.detail}`), `${d.title} / ${d.detail}`);
  check('…detail is the exact funds sentence with the smallest possible fee',
    d.detail === `Insufficient funds: sending ${10n ** 15n} wei plus a worst-case fee of at least ${minFee} wei exceeds the balance of ${10n ** 14n} wei`, d.detail);
  check('…and no estimate was requested at all (never one with value 0)', fetchNode.estimates.length === 0, JSON.stringify(fetchNode.estimates));
  fetchNode = null;

  if (HOODI_BUILT_IN) {
    const hs = hoodiState({ ethBalance: 0n });
    fetchNode = withEstimates(hs);
    const dep = await planStakingAction(fetchNode, STAKING_HOODI, EOA, { kind: 'stake', protocol: 'rocket-pool', amount: 10n ** 16n }, 'test ETH');
    const r = await rejection(() => prepareStakingSend(RPC_URL, EOA, dep));
    const rd = describeSendError(r, 'test ETH');
    check('Rocket Pool deposit at exactly the minimum with an empty account → the funds title, not the minimum-deposit revert',
      rd.title === 'Not enough test ETH to cover this amount plus the network fee.' && !/minimum deposit/i.test(rd.detail) && fetchNode.estimates.length === 0, `${rd.title} / ${rd.detail}`);
    fetchNode = null;
  }

  // Affordable value, but the node refuses the estimate for funds once the
  // fee is counted: one estimate at the real value, never a value-0 retry.
  const tight = sepoliaState({ ethBalance: 10n ** 15n + minFee });
  const tightNode = withEstimates(tight);
  fetchNode = async (method, params) => {
    if (method === 'eth_estimateGas' && BigInt(params[0].value ?? '0x0') + 120_000n * 3n * GWEI > tight.ethBalance) {
      tightNode.estimates.push(params[0]);
      throw new Error('insufficient funds for gas * price + value');
    }
    return tightNode(method, params);
  };
  const tplan = await planStakingAction(fetchNode, STAKING_SEPOLIA, EOA, stakeAction(10n ** 15n), 'test ETH');
  const t = await rejection(() => prepareStakingSend(RPC_URL, EOA, tplan));
  check('a funds refusal at estimation is not retried with value 0 (one estimate, the real value; no ZERO_DEPOSIT)',
    tightNode.estimates.length === 1 && BigInt(tightNode.estimates[0].value) === 10n ** 15n && !/ZERO_DEPOSIT/.test(String(t?.message)) &&
      describeSendError(t, 'test ETH').title === 'Not enough ETH to pay the network fee.', `${tightNode.estimates.length} / ${t?.message}`);
  // Phase 19 item 4: the fee title names the profile's coin when the caller
  // passes it (the Staking screen passes evmChain.displaySymbol); without the
  // third argument it reads exactly as before (send-nft, send-erc20 pins).
  check('…with the profile\'s symbol (the Staking screen\'s call) the title reads "Not enough test ETH to pay the network fee." on Sepolia',
    describeSendError(t, 'test ETH', 'test ETH').title === 'Not enough test ETH to pay the network fee.', describeSendError(t, 'test ETH', 'test ETH').title);
  check('…and the node\'s "insufficient funds for gas" broadcast refusal is titled the same way',
    describeSendError(new Error('insufficient funds for gas * price + value'), 'stETH', 'test ETH').title === 'Not enough test ETH to pay the network fee.');
  fetchNode = null;
}

// ---------------------------------------------------------------------------
console.log('check-staking: the unaffordable-stake title names the network\'s coin (2026-10-11 re-check, finding 5)');
// ---------------------------------------------------------------------------
{
  // The emulator showed "Not enough ETH to cover this amount plus the network
  // fee." on Ethereum Sepolia: the screen passed a hard-coded 'ETH' to
  // describeSendError. It now passes evmChain.displaySymbol ("test ETH").
  const screenSrc = readFileSync(join(APP_ROOT, 'src/screens/StakingScreen.tsx'), 'utf8');
  const symbolOk = (src) =>
    src.includes('function describeStakingError(e: unknown, symbol: string): string {') &&
    src.includes('const { title, detail } = describeSendError(e, symbol, symbol);') &&
    !src.includes("describeSendError(e, 'ETH')") &&
    !/describeStakingError\(e\)/.test(src) &&
    (src.match(/describeStakingError\(e, symbol\)/g) ?? []).length === 2 &&
    src.includes('const symbol = evmChain.displaySymbol;') &&
    // Phase 19 item 4: every describeSendError call passes the profile's
    // symbol as the fee coin too, so "Not enough ETH to pay the network
    // fee." reads "Not enough test ETH …" on a test network.
    (src.match(/describeSendError\(e, symbol, symbol\)/g) ?? []).length === 5 &&
    !/describeSendError\(e, symbol\)/.test(src);
  check('StakingScreen words its errors with evmChain.displaySymbol, never a hard-coded "ETH" (source)', symbolOk(screenSrc));
  check('…the old hard-coded call fails the check', !symbolOk(screenSrc.replace('describeSendError(e, symbol, symbol);', "describeSendError(e, 'ETH');")));
  check('…a call without the fee coin (the screen before phase 19 item 4) fails the check',
    !symbolOk(screenSrc.replace('describeSendError(e, symbol, symbol);', 'describeSendError(e, symbol);')));
  check('…and with "test ETH" the title reads "Not enough test ETH to cover this amount plus the network fee."',
    describeSendError(new Error('Insufficient funds: sending 1000000000000000000 wei plus a worst-case fee of at least 21000672000 wei exceeds the balance of 2318893341920775 wei.'), 'test ETH').title ===
      'Not enough test ETH to cover this amount plus the network fee.');
  const sheet = readFileSync(join(APP_ROOT, 'src/components/WcApprovalSheet.tsx'), 'utf8');
  const wcContext = readFileSync(join(APP_ROOT, 'src/wallet/WalletConnectContext.tsx'), 'utf8');
  check('the WalletConnect sheet and the smart-account WalletConnect path name the network\'s coin too (same bug)',
    !sheet.includes("describeSendError(e, 'ETH')") && (sheet.match(/describeSendError\(e, evmChain\.displaySymbol, evmChain\.displaySymbol\)/g) ?? []).length === 2 &&
      !wcContext.includes("describeSendError(e, 'ETH')") &&
      // Phase 20 item 3: the fee coin too, from the request's own network.
      (wcContext.match(/describeSendError\(e, feeSymbolForChain\(item\.chain\), feeSymbolForChain\(item\.chain\)\)/g) ?? []).length === 2);
}

// ---------------------------------------------------------------------------
console.log('check-staking: success notes, the balances holder line and the smart-account success view (phase 18 findings 2, 4, 7)');
// ---------------------------------------------------------------------------
{
  check('success note, regular account, stETH tracked (exact)',
    stakingSuccessBalanceNote({ smartAccount: false, stethTracked: true }) ===
      'The stETH balance on this screen and on Home is read from the token itself, so it is exact whenever it is read.');
  const untracked = 'The stETH balance on this screen is read from the token itself, so it is exact whenever it is read. Home shows it once stETH is on this network’s tracked tokens (Manage tokens).';
  check('success note, regular account, stETH not tracked or unknown: points at this screen (exact)',
    stakingSuccessBalanceNote({ smartAccount: false, stethTracked: false }) === untracked && stakingSuccessBalanceNote({ smartAccount: false, stethTracked: null }) === untracked);
  check('success note, smart account: says Home shows the regular account’s balances (exact), whatever the tracking',
    [true, false, null].every((t) => stakingSuccessBalanceNote({ smartAccount: true, stethTracked: t }) ===
      'The stETH balance on this screen is your smart account’s, read from the token itself, so it is exact whenever it is read. Home’s token rows show your regular account’s balances, not the smart account’s.'));
  check('only the tracked regular-account note claims a Home row',
    stakingSuccessBalanceNote({ smartAccount: false, stethTracked: false }).includes('on Home') === false &&
      stakingSuccessBalanceNote({ smartAccount: true, stethTracked: true }).includes('on Home') === false);
  check('holder line (exact): smart account / regular account',
    stakingBalancesHolderLine(true, KERNEL_ACCOUNT_0) === `Balances of your smart account ${KERNEL_ACCOUNT_0}` &&
      stakingBalancesHolderLine(false, EOA) === `Balances of your regular account ${EOA}`);

  const screen = readFileSync(join(APP_ROOT, 'src/screens/StakingScreen.tsx'), 'utf8');
  const views = readFileSync(join(APP_ROOT, 'src/screens/StakingViews.tsx'), 'utf8');
  check('the old sentence naming Home unconditionally is gone',
    !screen.includes('The stETH balance on Home and here is read from the token itself'));
  check('the success note comes from stakingSuccessBalanceNote with the path and the tracked state',
    screen.includes('{stakingSuccessBalanceNote({ smartAccount: aaResult !== null, stethTracked })}') &&
      screen.includes('.then(() => (plan.rebasing ? isStethTracked(chainAtSend) : null))'));
  check('the balances card names its holder, read with the balances (smart account when the toggle is on)',
    views.includes('{holderLine}') &&
      screen.includes('holderLine={stakingBalancesHolderLine(balancesHolder.smartAccount, balancesHolder.address)}') &&
      screen.includes('holder: { address: holder, smartAccount: bundle !== null },'));
  // The smart-account success view mirrors SendScreen's: the receipt poll,
  // "Bundling…", the included / reverted line, the bundle transaction and
  // the explorer link gated on the profile's explorerTxBase.
  const send = readFileSync(join(APP_ROOT, 'src/screens/SendScreen.tsx'), 'utf8');
  const flat = (t) => t.replace(/\s+/g, ' ');
  const shared = [
    'Bundling… waiting for the UserOperation receipt.',
    'No receipt yet. The operation may still be included — keep the UserOperation hash above to look it up later.',
    'The bundler reports the operation was included but reverted on-chain. The gas was still charged to the smart account.',
    "Included on-chain{aaResult.success === true ? ' — succeeded.' : '.'}",
    'The bundler&apos;s receipt did not include a recognizable transaction hash; look the UserOperation hash up in an ERC-4337 explorer you trust.',
    '{evmChain.explorerTxBase ? (',
    'void Linking.openURL(`${evmChain.explorerTxBase}${aaResult.txHash}`)',
    '<Text style={[styles.label, { color: theme.textMuted }]}>Transaction</Text>',
  ];
  const missing = shared.filter((t) => !flat(screen).includes(flat(t)) || !flat(send).includes(flat(t)));
  check('the smart-account success view carries SendScreen’s receipt texts, the bundle transaction and the gated explorer link', missing.length === 0, missing.join(' | '));
  check('…the receipt is polled with waitForAaReceipt and the bundle transaction shown as text, not only as a button',
    screen.includes('void waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 })') &&
      /\{aaResult\.txHash\}\s*<\/Text>/.test(screen));

  // Item 3 emulator finding 1: the private note on both success views, as on
  // Send and Swap (TransactionNoteField, the network captured at sending).
  const noteProblems = (src) => {
    const p = [];
    const need = (what, ok) => { if (!ok) p.push(what); };
    const success = src.slice(src.indexOf("if (phase === 'success' && (result || aaResult) && plan) {"), src.indexOf('// ------------------------------------------------- approve (EOA, step 1)'));
    const done = success.indexOf('title="Done"');
    const aaField = '<TransactionNoteField network={sentNetwork} txid={aaResult.txHash} userOpHash={aaResult.userOpHash} />';
    const eoaField = '<TransactionNoteField network={sentNetwork} txid={result.txid} userOpHash={null} />';
    need('the component is imported', /import \{[^}]*\bTransactionNoteField\b[^}]*\} from '\.\.\/components\/TransactionNoteField';/.test(src));
    need('smart-account view: the UserOperation hash first, the bundle hash when it arrives', success.includes('{sentNetwork && aaResult ? (') && success.includes(aaField));
    need('regular-account view: the transaction id', success.includes('{sentNetwork && !aaResult && result ? (') && success.includes(eoaField));
    need('both above Done', done > 0 && success.indexOf(aaField) > 0 && success.indexOf(aaField) < done && success.indexOf(eoaField) > 0 && success.indexOf(eoaField) < done);
    need('the network captured when each path sent', (src.match(/setSentNetwork\(caip2\);/g) ?? []).length === 2 &&
      /sendEvm\(sendUrl, signer, eoaQuote, evmChain\.explorerTxBase\),\s*\);\s*setSentNetwork\(caip2\);/.test(src) &&
      /sendAa\(bundle, signer, aaQuote, \{ kind: 'staking' \}\)\);\s*setSentNetwork\(caip2\);/.test(src));
    need('Done clears it', success.includes('setSentNetwork(null);'));
    return p;
  };
  const np = noteProblems(screen);
  check('the Staking success views render the private note above Done (both paths; the network captured at sending)', np.length === 0, np.join('; '));
  for (const [name, from, to] of [
    ['the smart-account field removed', '<TransactionNoteField network={sentNetwork} txid={aaResult.txHash} userOpHash={aaResult.userOpHash} />', ''],
    ['the regular-account field removed', '<TransactionNoteField network={sentNetwork} txid={result.txid} userOpHash={null} />', ''],
    ['the smart-account field without the UserOperation hash', 'txid={aaResult.txHash} userOpHash={aaResult.userOpHash}', 'txid={aaResult.txHash} userOpHash={null}'],
  ]) {
    check(`mutant (${name}) is caught`, noteProblems(screen.replace(from, to)).length > 0);
  }
  check('the old screen (no note field) fails the check', noteProblems(screen.replaceAll(/\{sentNetwork && (?:!aaResult && result|aaResult) \? \([\s\S]*?\) : null\}/g, '')).length > 0);
  // The component itself moves a note saved under the UserOperation hash to
  // the bundle transaction once its hash is known.
  const field = readFileSync(join(APP_ROOT, 'src/components/TransactionNoteField.tsx'), 'utf8');
  check('TransactionNoteField links the UserOperation note to the bundle transaction when the hash arrives',
    field.includes('linkUserOperation(network, userOpHash, txid)') && /if \(!txid \|\| !userOpHash \|\| savedCount === 0\) return;/.test(field));
  // …and that move works on the note store (the same functions, a memory store).
  const notes = await import('../src/wallet/notes.ts');
  const mem = new Map();
  const store = { getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => { mem.set(k, v); }, removeItem: async (k) => { mem.delete(k); } };
  const OP = '0x' + '3a'.repeat(32);
  const TX = '0x' + '59'.repeat(32);
  await notes.saveNote(STAKING_SEPOLIA, { txid: null, userOpHash: OP }, 'staked for the demo', { store });
  const before = await notes.loadNotes(store);
  const linked = await notes.linkUserOperation(STAKING_SEPOLIA, OP, TX, store);
  const after = await notes.loadNotes(store);
  check('a note saved under the UserOperation hash is moved to the bundle transaction (linkUserOperation)',
    before.notes.length === 1 && before.notes[0].txid === null && linked === 'moved' &&
      after.notes.length === 1 && after.notes[0].txid === TX && after.notes[0].userOpHash === OP && after.notes[0].text === 'staked for the demo', JSON.stringify(after.notes));
}

// ---------------------------------------------------------------------------
console.log('check-staking: mutation checks (each mutant must be caught)');
// ---------------------------------------------------------------------------
{
  // M1: the live pause check. Without it, Sepolia unstaking is no longer
  // refused with the paused sentence.
  const sepoliaUnstakeRefusedAsPaused = async (mod) => {
    const e = await rejection(() => mod.planStakingAction(stakingNode(sepoliaState()), STAKING_SEPOLIA, EOA, { kind: 'unstake', amount: 10n ** 15n }, 'ETH'));
    return e?.message === SEPOLIA_UNSTAKE_PAUSED;
  };
  check('M1 baseline: Sepolia unstake refused as paused', await sepoliaUnstakeRefusedAsPaused({ planStakingAction }));
  const m1 = await stakingMutant('    unstakeRefusal: state.queuePaused\n', '    unstakeRefusal: false\n');
  check('M1 caught: without the isPaused() check the Sepolia refusal disappears', !(await sepoliaUnstakeRefusedAsPaused(m1)));

  // M2: the mainnet gate. Without every assertFeatureAllowed('staking', …),
  // mainnet is no longer refused before a request.
  const mainnetRefusedWithoutRequests = async (mod) => {
    const node = stakingNode(sepoliaState({ chainIdHex: '0x1' }));
    const e = await rejection(() => mod.planStakingAction(node, 'eip155:1', EOA, stakeAction(E18), 'ETH'));
    let offerThrew = false;
    try {
      mod.stakingOfferFor('eip155:1');
    } catch {
      offerThrew = true;
    }
    return e?.name === 'FeatureNotAllowedError' && node.calls.length === 0 && offerThrew;
  };
  check('M2 baseline: mainnet refused before any request', await mainnetRefusedWithoutRequests({ planStakingAction, stakingOfferFor }));
  const m2 = await stakingMutant("  assertFeatureAllowed('staking', caip2);\n", '', true);
  check('M2 caught: without the readiness gate, mainnet is reached', !(await mainnetRefusedWithoutRequests(m2)));

  // M3: the Hoodi Kernel refusal (both its sentence and the refusal itself).
  if (HOODI_BUILT_IN) {
    const refusedExactly = async (mod) => {
      const { e, requests } = await hoodiAaAttempt(mod);
      return e?.message === HOODI_NO_SMART_ACCOUNT && requests === 0;
    };
    check('M3 baseline: Hoodi smart account refused exactly', await refusedExactly({ prepareStakingAa }));
    const m3a = await stakingMutant('  if (caip2 === STAKING_HOODI) return HOODI_NO_SMART_ACCOUNT;\n', '');
    check('M3a caught: without the Hoodi line the exact sentence is gone', !(await refusedExactly(m3a)));
    const m3b = await stakingMutant('  const refusal = stakingSmartAccountRefusal(plan.caip2);\n', '  const refusal = null;\n');
    check('M3b caught: without the refusal the bundle is used', !(await refusedExactly(m3b)));
  } else {
    const m3 = await stakingMutant('  if (caip2 === STAKING_HOODI) return HOODI_NO_SMART_ACCOUNT;\n', '');
    check('M3 caught (pure): without the Hoodi line the exact sentence is gone', m3.stakingSmartAccountRefusal(STAKING_HOODI) !== HOODI_NO_SMART_ACCOUNT);
  }

  // M4: the exact approval. An unlimited approval must be caught.
  const approvalIsExact = async (mod) => {
    const st = sepoliaState();
    st.balances[`${SEP.stETH.toLowerCase()}|${EOA.toLowerCase()}`] = 10n ** 16n;
    fetchNode = stakingNode(st);
    const plan = await mod.planStakingAction(fetchNode, STAKING_SEPOLIA, EOA, { kind: 'wrap', amount: 10n ** 15n }, 'ETH');
    const q = await mod.prepareStakingSend(RPC_URL, EOA, plan);
    fetchNode = null;
    const expected = new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [SEP.wstETH, 10n ** 15n]);
    return q.step === 'approve' && toHex(q.quote.data) === expected;
  };
  check('M4 baseline: the approval is exactly the amount', await approvalIsExact({ planStakingAction, prepareStakingSend }));
  const m4 = await stakingMutant(
    'encodeErc20Approve(plan.approval.spender, plan.approval.amount)',
    'encodeErc20Approve(plan.approval.spender, (1n << 256n) - 1n)',
  );
  check('M4 caught: an unlimited approval is detected', !(await approvalIsExact(m4)));
}

// Pass p20c (TalkBack, 2026-10-14) finding 6.
console.log('\ncheck-staking: pass p20c finding 6 (what TalkBack says on the Staking screen)');
{
  const { spokenTokenName, spokenSiteName, withShortAddresses } = await import('../src/a11y.ts');
  const { stakingTokenName } = await import('../src/wallet/tokens.ts');
  const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  check('token symbols are spoken with the full name from tokens.ts, not spelled out (exact)',
    spokenTokenName('stETH', stakingTokenName('stETH')) === 'Liquid staked Ether 2.0 (stETH)' &&
      spokenTokenName('wstETH', stakingTokenName('wstETH')) === 'Wrapped liquid staked Ether 2.0 (wstETH)' &&
      spokenTokenName('rETH', stakingTokenName('rETH')) === 'Rocket Pool ETH (rETH)' &&
      stakingTokenName('USDC') === null && spokenTokenName('USDC', null) === 'USDC');
  check('the source link is spoken as the site, not the raw URL (exact)',
    spokenSiteName('https://docs.lido.fi/guides/steth-integration-guide') === 'docs.lido.fi' &&
      spokenSiteName('https://www.example.org/x?y') === 'example.org' && spokenSiteName('not a url') === 'not a url');
  check('the holder line speaks the account address short (exact)',
    withShortAddresses('Balances of your regular account 0x772eF8c0b0A9E1d3b2C4D5e6F7a8B9c0d1E2F44F') === 'Balances of your regular account 0x772e…F44F');
  const views = readSrc('../src/screens/StakingViews.tsx');
  const screen = readSrc('../src/screens/StakingScreen.tsx');
  const viewsOk = (src) =>
    src.includes('accessibilityLabel={`Source: ${statement.source}, read ${statement.read}. ${spokenSiteName(statement.url)}`}') &&
    src.includes('`${spokenTokenName(symbol, stakingTokenName(symbol))}: ${hidden ? \'amount hidden\' : exact18(amount)}${sub ? `. ${sub}` : \'\'}`') &&
    src.includes('<Row key={l.label} label={l.label} value={l.value} sub={l.sub ?? null} spoken={l.spoken} theme={theme} />') &&
    src.includes('accessibilityLabel={withShortAddresses(holderLine)}');
  check('StakingViews: balance rows read as one sentence with the full token name; the source link and holder line as above (source)', viewsOk(views));
  check('…mutant caught: the old source link read as the raw URL',
    !viewsOk(views.replace('accessibilityLabel={`Source: ${statement.source}, read ${statement.read}. ${spokenSiteName(statement.url)}`}', '')));
  const switchOk = (src) =>
    /<Switch \{\.\.\.switchColors\(theme\)\}\s+accessibilityLabel="Use the smart account"/.test(src) &&
    /<Text importantForAccessibility="no" accessibilityElementsHidden style=\{\[styles\.toggleLabel, \{ color: theme\.text \}\]\}>\s*Use the smart account\s*<\/Text>/.test(src);
  check('the smart-account switch is read once: it carries the visible label, the label text is hidden (source)', switchOk(screen));
  check('…mutant caught: the old pair (switch "Stake from the smart account" + a spoken label)',
    !switchOk(screen.replace('accessibilityLabel="Use the smart account"', 'accessibilityLabel="Stake from the smart account"')));
  check('the From / Owner account rows speak the address short (source)',
    (screen.match(/spoken=\{`(From account|Owner account \(signs\)): \$\{activeAccount\?\.name \?\? 'unknown'\}, \$\{spokenShortAddress\(account\.address\)\}`\}/g) ?? []).length === 3);
  // Pass p20d finding 3: TalkBack stopped a second time on the amount
  // ("0.001315… stETH. Actions available"): a selectable Text is its own
  // focusable, long-clickable node. With a spoken row label, the amount is
  // hidden from screen readers and stays selectable for sight.
  const rowValueOk = (src) =>
    /<Text\s+selectable\s+\{\.\.\.\(spoken !== undefined \? \{ importantForAccessibility: 'no' as const, accessibilityElementsHidden: true \} : \{\}\)\}\s+style=\{\[styles\.rowValue,/.test(src) &&
    src.includes("{...(spoken !== undefined ? { accessible: true, accessibilityLabel: spoken } : {})}");
  check('p20d finding 3: a balance row is ONE element — its selectable amount is hidden from screen readers when the row has a spoken label (source)', rowValueOk(views));
  check('…mutant caught: the amount exposed again as a second item',
    !rowValueOk(views.replace("{...(spoken !== undefined ? { importantForAccessibility: 'no' as const, accessibilityElementsHidden: true } : {})}", '')));
}

console.log(`\ncheck-staking: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * Dollar-cost averaging on a Kernel v3.3 session key, Ethereum Sepolia only
 * (phase 19 item 2), driven only by engine code
 * (packages/chains-evm/src/kernel-dca.ts on top of kernel-permissions.ts).
 *
 * The grant lets a session key call Uniswap's SwapRouter02
 * exactInputSingle with every argument pinned (pair, pool fee, recipient =
 * the account, the exact amount, a STATIC minimum-out floor, no price
 * limit), at most once per period, within a window and a fee budget. Built
 * on the same template as subscriptions (CallPolicy, TimestampPolicy,
 * GasPolicy, RateLimitPolicy; the signer with SKIP_SIGNATURE).
 *
 * DRY RUN (default; read-only, no dev keys, nothing broadcast):
 *   node scripts/testnet/dca-smoke.mjs
 *   Checks SwapRouter02 / QuoterV2 / the pinned pool on-chain, then one
 *   eth_simulateV1 request per scenario against the real Sepolia EntryPoint
 *   v0.7, Kernel v3.3, ZeroDev policies and Uniswap pool, for the PUBLIC
 *   test mnemonic's undeployed Kernel accounts:
 *     (A) selling ETH: deploy + install; a swap before the first slot; swap 1;
 *         a second swap in the same slot; a lower floor; another recipient;
 *         another tokenOut; a larger amountIn (value too, then value
 *         unchanged); a price limit; the batching RESIDUAL (two in-rule swaps
 *         in one operation, accepted by the account); a swap asking 100x the
 *         quote (validation passes, the swap reverts "Too little received",
 *         the slot is used up, no ETH leaves the account); the last swap; one
 *         more (count used up); revoke; a swap after revocation.
 *     (B) selling USDC (balance set by a state override): approve + swap
 *         accepted; an approval larger than the amount refused.
 * LIVE (DCA_LIVE=1; reads .dev-wallet/mnemonic.txt and the ZeroDev project
 * id from the environment, never printed):
 *   set -a; . .dev-wallet/env; set +a; DCA_LIVE=1 node scripts/testnet/dca-smoke.mjs
 *   On the dev seed's index-2 Kernel account on Sepolia
 *   (0x1D723b78e1D0D84Fd0531e2686285fb1B6414106): tops it up from the dev EOA
 *   with at most 0.005 ETH when needed; quotes QuoterV2; installs a grant
 *   (DCA_AMOUNT_WEI per swap, default 1e13 = 0.00001 test ETH, every
 *   DCA_PERIOD seconds, default 120, x2, floor = 95% of the quote, one period
 *   of grace) with a fresh session key saved 0600 in .dev-wallet/ BEFORE the
 *   install; swap 1 through ZeroDev with the session key; an over-amount
 *   swap and an early second swap (each with a bundler wrapper that refuses
 *   eth_sendUserOperation, so a negative test can never broadcast, plus a
 *   decoded handleOps eth_call); swap 2 after its slot; revoke; a swap after
 *   revocation (negative). Results: scripts/testnet/runs/dca-run.json
 *   (git-ignored; public facts only).
 *
 * Environment: ZERODEV_PROJECT_ID or BUNDLER_URL (live only, never printed);
 * NODE_URL (default the public Sepolia RPC). Sepolia only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  DCA_EXACT_INPUT_SINGLE_SELECTOR,
  DCA_NATIVE,
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  NodeClient,
  SmartAccountClient,
  UNISWAP_V3_SEPOLIA,
  buildDcaSwapCall,
  buildDcaSwapCalls,
  createKernelAccountSpec,
  createSessionKeyAccount,
  dcaFloorFromQuote,
  dcaGrantFor,
  dcaMinimumOutFor,
  dcaValidUntil,
  decodeDcaOutcome,
  describeDca,
  encodeDcaSwapData,
  encodeFunctionCall,
  encodeKernelExecute,
  encodePermissionInstall,
  formatBaseUnits,
  formatUtc,
  generateSessionPrivateKey,
  getUserOpHash,
  kernelDcaSpec,
  kernelSessionSpec,
  nextPullAllowedAt,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  permissionRevokeCall,
  prepareKernelPermissionInstall,
  quoteDcaSwap,
  readDcaPool,
  readDcaState,
  readKernelPermissionState,
  readSessionSigner,
  serializeDcaTerms,
  signEip1559,
  toBytes,
  toHex,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const LIVE = process.env.DCA_LIVE === '1';
const CHAIN_ID = 11155111n;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID
    ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/11155111`
    : undefined);
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const WETH = UNISWAP_V3_SEPOLIA.weth9;
const ROUTER = UNISWAP_V3_SEPOLIA.swapRouter02;
const FEE = 500;
const LIVE_INDEX = 2n;
const LIVE_ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const DEV_EOA = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const MAX_TOP_UP_WEI = 5_000_000_000_000_000n; // 0.005 ETH per run, the task's cap
const TOP_UP_WEI = BigInt(process.env.DCA_TOP_UP_WEI ?? MAX_TOP_UP_WEI.toString());
/*
 * Measured 2026-10-11 (read-only probes): ZeroDev's eth_estimateUserOperationGas
 * for this install answered "AA21 didn't pay prefund" at maxFee 1.1 gwei and
 * passed at 1.0 gwei with 0.00798 ETH of balance + deposit, i.e. its
 * simulation reserves roughly 7.3M-8M gas of prefund although the install
 * uses about 3M. So the account needs about 0.011 ETH to be ESTIMATED at
 * ZeroDev's ~1.155 gwei standard fee.
 */
const TOP_UP_BELOW_WEI = 11_000_000_000_000_000n;
const AMOUNT_WEI = BigInt(process.env.DCA_AMOUNT_WEI ?? '10000000000000');
const PERIOD = Number(process.env.DCA_PERIOD ?? '120');
const PADDING = { verification: 120, call: 130, preVerification: 105 };
/*
 * The install's callGasLimit estimate was 7,478,405 gas on 2026-10-11 (seven
 * CallPolicy rules written to fresh storage after Glamsterdam), so 130%
 * padding alone asks for ~9.7M gas of prefund. DCA_INSTALL_CALL_PADDING
 * lowers the padding for the install only (default 130).
 */
const INSTALL_PADDING = { ...PADDING, call: Number(process.env.DCA_INSTALL_CALL_PADDING ?? '130') };
if (!(INSTALL_PADDING.call >= 105 && INSTALL_PADDING.call <= 200)) throw new Error('DCA_INSTALL_CALL_PADDING must be 105..200');
const DEV = new URL('../../.dev-wallet/', import.meta.url);
const KEY_FILE = new URL('dca-session.key', DEV);
const RUNS_DIR = new URL('./runs/', import.meta.url);
const RUN_FILE = new URL('dca-run.json', RUNS_DIR);
const EIP7708 = '0xfffffffffffffffffffffffffffffffffffffffe';

if (LIVE && !BUNDLER_URL) {
  console.error('DCA_LIVE=1 needs ZERODEV_PROJECT_ID (or BUNDLER_URL) from .dev-wallet/env.');
  process.exit(1);
}
if (AMOUNT_WEI <= 0n || AMOUNT_WEI > 500_000_000_000_000n) {
  console.error('DCA_AMOUNT_WEI must be between 1 wei and 0.0005 ETH.');
  process.exit(1);
}

/** Never print a bundler URL: it embeds the project id. */
function mask(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) out = out.split(secret).join('<masked>');
  return out;
}
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** JSON-RPC that keeps error.data (httpTransport drops it). */
async function rawRpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(mask(`HTTP ${response.status} for ${method}: ${text.slice(0, 300)}`));
  }
  if (body.error) {
    const error = new Error(mask(`RPC error ${body.error.code ?? '(no code)'}: ${body.error.message ?? json(body.error)} (${method})`));
    error.data = body.error.data;
    throw error;
  }
  if (!response.ok) throw new Error(mask(`HTTP ${response.status} for ${method}`));
  return body.result;
}
const node = (method, params) => rawRpc(NODE_URL, method, params);
const nodeClient = new NodeClient(node);

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const topic = (sig) => toHex(keccak_256(utf8ToBytes(sig)));
const errorSelector = (sig) => topic(sig).slice(0, 10);
const USER_OPERATION_EVENT = topic('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
const KNOWN_ERRORS = Object.fromEntries(
  [
    'FailedOp(uint256,string)',
    'FailedOpWithRevert(uint256,string,bytes)',
    'Error(string)',
    'InvalidCallType()',
    'InvalidCallData()',
    'CallViolatesParamRule()',
    'CallViolatesValueRule()',
    'InvalidValidator()',
    'InvalidNonce()',
    'PolicyFailed(uint256)',
    'SignerPrefixNotPresent()',
    'PermissionNotAlllowedForUserOp()',
    'InvalidValidationType()',
  ].map((s) => [errorSelector(s), s]),
);
const POLICY_NAMES = ['CallPolicy', 'TimestampPolicy', 'GasPolicy', 'RateLimitPolicy'];

function abiString(body, offsetWord) {
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  const strOffset = Number(BigInt('0x' + word(offsetWord))) / 32;
  const strLen = Number(BigInt('0x' + word(strOffset)));
  return Buffer.from(body.slice((strOffset + 1) * 64, (strOffset + 1) * 64 + strLen * 2), 'hex').toString();
}

function describeRevert(data) {
  if (typeof data !== 'string' || data.length < 10) return `revert data ${data}`;
  const sel = data.slice(0, 10).toLowerCase();
  const name = KNOWN_ERRORS[sel];
  if (!name) return `revert ${sel} (unknown selector)`;
  const body = data.slice(10);
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  if (name === 'PolicyFailed(uint256)') {
    const i = Number(BigInt('0x' + word(0)));
    return `PolicyFailed(${i}) = ${POLICY_NAMES[i] ?? 'policy ' + i}`;
  }
  if (name === 'Error(string)') return `Error("${abiString(body, 0)}")`;
  if (!name.startsWith('FailedOp')) return name;
  const reason = abiString(body, 1);
  let inner = '';
  if (name.startsWith('FailedOpWithRevert')) {
    const bOffset = Number(BigInt('0x' + word(2))) / 32;
    const bLen = Number(BigInt('0x' + word(bOffset)));
    const innerData = '0x' + body.slice((bOffset + 1) * 64, (bOffset + 1) * 64 + bLen * 2);
    inner = innerData === '0x' ? ' -> inner revert without data' : ` -> ${describeRevert(innerData)}`;
  }
  return `${name.split('(')[0]}("${reason}")${inner}`;
}

function decodeErrorText(error) {
  const parts = [];
  const candidates = [];
  if (typeof error?.data === 'string') candidates.push(error.data);
  if (error?.data && typeof error.data === 'object') candidates.push(...Object.values(error.data).filter((v) => typeof v === 'string'));
  for (const m of String(error?.message ?? error).matchAll(/0x[0-9a-fA-F]{8,}/g)) candidates.push(m[0]);
  for (const c of candidates) {
    const d = describeRevert(c);
    if (!d.includes('unknown selector') && !d.startsWith('revert data')) parts.push(d);
  }
  return [...new Set(parts)];
}

function encodeHandleOps(op, beneficiary) {
  const packed = {
    kind: 'tuple',
    items: [
      { kind: 'address', value: op.sender },
      { kind: 'uint256', value: op.nonce },
      { kind: 'bytes', value: packInitCode(op) },
      { kind: 'bytes', value: op.callData },
      { kind: 'fixedBytes', value: packUint128Pair(op.verificationGasLimit, op.callGasLimit) },
      { kind: 'uint256', value: op.preVerificationGas },
      { kind: 'fixedBytes', value: packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas) },
      { kind: 'bytes', value: packPaymasterAndData(op) },
      { kind: 'bytes', value: op.signature },
    ],
  };
  return encodeFunctionCall(
    'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)',
    [{ kind: 'array', items: [packed] }, { kind: 'address', value: beneficiary }],
  );
}

/** UserOperationEvent fields for `userOpHash`: success, actualGasCost, actualGasUsed. */
function userOpEvent(logs, userOpHash) {
  for (const log of logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() !== USER_OPERATION_EVENT) continue;
    if (log.topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    const w = (i) => BigInt('0x' + log.data.slice(2 + i * 64, 2 + (i + 1) * 64));
    return { success: w(1) === 1n, actualGasCost: w(2), actualGasUsed: w(3) };
  }
  return null;
}

/** EIP-7708 ETH transfer logs leaving `from` (post-Glamsterdam Sepolia). */
function ethLeaving(logs, from) {
  return (logs ?? []).filter(
    (l) =>
      l.address?.toLowerCase() === EIP7708 &&
      l.topics?.[0]?.toLowerCase() === topic('Transfer(address,address,uint256)') &&
      ('0x' + l.topics[1].slice(26)).toLowerCase() === from.toLowerCase(),
  );
}

function keyring(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry);
}

async function chainTime() {
  const block = await node('eth_getBlockByNumber', ['latest', false]);
  return Number(BigInt(block.timestamp));
}

async function requireSepolia() {
  const id = await nodeClient.chainId();
  if (id !== CHAIN_ID) throw new Error(`Not Sepolia: chain id ${id}`);
}

const usdcBalance = async (who, block = 'latest') =>
  BigInt(await node('eth_call', [{ to: USDC, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: who }])) }, block]));
const entryPointDeposit = async (who, block = 'latest') =>
  BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: who }])) }, block]));

/** On-chain facts the plan rests on, re-read every run. */
async function checkVenue() {
  const word = async (to, sig) => node('eth_call', [{ to, data: toHex(encodeFunctionCall(sig, [])) }, 'latest']);
  const addr = (w) => ('0x' + w.slice(26)).toLowerCase();
  const routerFactory = addr(await word(ROUTER, 'factory()'));
  const routerWeth = addr(await word(ROUTER, 'WETH9()'));
  const quoterFactory = addr(await word(UNISWAP_V3_SEPOLIA.quoterV2, 'factory()'));
  const code = await node('eth_getCode', [ROUTER, 'latest']);
  const hasSelector = code.toLowerCase().includes('63' + DCA_EXACT_INPUT_SINGLE_SELECTOR.slice(2));
  if (routerFactory !== UNISWAP_V3_SEPOLIA.factory.toLowerCase() || routerWeth !== WETH.toLowerCase()) {
    throw new Error('SwapRouter02 does not report the pinned factory / WETH9');
  }
  if (quoterFactory !== UNISWAP_V3_SEPOLIA.factory.toLowerCase()) throw new Error('QuoterV2 does not report the pinned factory');
  if (!hasSelector) throw new Error('SwapRouter02 code does not contain PUSH4 0x04e45aaf');
  const pool = await readDcaPool(node, { chainId: CHAIN_ID, tokenIn: DCA_NATIVE, tokenOut: USDC, fee: FEE });
  console.log(
    `Venue: SwapRouter02 ${ROUTER} (factory ${routerFactory}, WETH9 ${routerWeth}, ${(code.length - 2) / 2} bytes, ` +
      `dispatch contains PUSH4 ${DCA_EXACT_INPUT_SINGLE_SELECTOR}); pool ${pool.pool} USDC/WETH ${FEE / 10000}% ` +
      `liquidity ${pool.liquidity} tick ${pool.tick}`,
  );
  return pool;
}

// ---------------------------------------------------------------------------
// DRY RUN
// ---------------------------------------------------------------------------

const SIM_GAS = {
  callGasLimit: 3_000_000n,
  verificationGasLimit: 1_500_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};
const SESSION_GAS = { ...SIM_GAS, verificationGasLimit: 600_000n, callGasLimit: 800_000n };
const sign = (op, signer, spec) => ({ ...op, signature: spec.signUserOpHash(signer, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) });

async function simulateScenario(name, { account, owner, rootSpec, terms, sessionKey, steps, stateOverrides }) {
  const latest = await chainTime();
  const grant = dcaGrantFor(terms, sessionKey.address, { now: latest });
  const inst = encodePermissionInstall(grant, { chainId: CHAIN_ID, account, currentNonce: 1, validationNonce: 0, now: latest });
  const raw = kernelSessionSpec({ account, sessionKey: sessionKey.address, permissionId: inst.permissionId });
  const factory = await rootSpec.getFactoryArgs(owner);
  console.log(`\n== DRY RUN ${name}: account ${account} (public test mnemonic, undeployed); permission ${toHex(inst.permissionId)}`);
  let seq = 0n;
  let rootNonce = 0n;
  const ops = [];
  const blockStateCalls = [];
  for (const [i, step] of steps.entries()) {
    let op;
    if (step.kind === 'install') {
      op = sign({ sender: account, nonce: rootNonce++, ...factory, callData: encodeKernelExecute(inst.installCalls), ...SIM_GAS }, owner, rootSpec);
    } else if (step.kind === 'revoke') {
      op = sign(
        { sender: account, nonce: rootNonce++, callData: encodeKernelExecute([permissionRevokeCall(account, inst.permissionId, inst.policyCount)]), ...SIM_GAS },
        owner,
        rootSpec,
      );
    } else {
      op = sign({ sender: account, nonce: (raw.nonceKey << 64n) + seq, callData: encodeKernelExecute(step.calls()), ...SESSION_GAS }, sessionKey, raw);
      // The nonce advances whenever validation passes (including a swap that reverts in execution).
      if (step.expect !== 'rejected') seq += 1n;
    }
    ops.push(op);
    blockStateCalls.push({
      blockOverrides: { time: '0x' + step.time.toString(16) },
      ...(i === 0 ? { stateOverrides } : {}),
      calls: [
        { from: owner.address, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, owner.address)), gas: '0x1c9c380' },
        { from: owner.address, to: USDC, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: account }])) },
      ],
    });
  }
  const result = await node('eth_simulateV1', [{ blockStateCalls }, 'latest']);
  let failed = false;
  const rows = [];
  steps.forEach((step, i) => {
    const call = result[i].calls[0];
    const hash = toHex(getUserOpHash(ops[i], ENTRYPOINT_V07, CHAIN_ID));
    const event = call.status === '0x1' ? userOpEvent(call.logs, hash) : null;
    const outcome = call.status !== '0x1' ? 'rejected' : event?.success ? 'accepted' : 'reverted-in-execution';
    let detail;
    if (outcome === 'rejected') {
      detail = describeRevert(call.error?.data ?? call.returnData);
    } else if (step.kind === 'swap') {
      const o = decodeDcaOutcome(terms, call.logs ?? [], { userOpHash: hash });
      const left = ethLeaving(call.logs, account).filter((l) => ('0x' + l.topics[2].slice(26)).toLowerCase() === ROUTER.toLowerCase());
      detail =
        `${o.swaps.length} Swap event(s), ${terms.tokenOut === USDC ? 'USDC' : 'WETH'} to the account ${o.tokenOutReceived}` +
        `${o.atOrAboveFloor ? ' (>= floor)' : ''}; ETH account->router logs ${left.length}` +
        (o.revertReason ? `; revert ${describeRevert(o.revertReason)}` : '');
    } else {
      detail = `UserOperationEvent success=${event?.success}`;
    }
    const expectedText = step.expectText ? describeRevert(call.error?.data ?? call.returnData).includes(step.expectText) : true;
    const ok = outcome === step.expect && expectedText;
    if (!ok) failed = true;
    rows.push({ step: step.name, expected: step.expect, outcome, detail, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} [t=${step.time - terms.startAt >= 0 ? 'S+' : 'S'}${step.time - terms.startAt}] ${step.name}: ${outcome} (${detail})`);
  });
  return { name, account, permissionId: toHex(inst.permissionId), rows, failed };
}

async function dryRun() {
  await requireSepolia();
  await checkVenue();
  const keys = keyring(PUBLIC_TEST_MNEMONIC);
  const latest = await chainTime();
  const quote = await quoteDcaSwap(node, { chainId: CHAIN_ID, tokenIn: DCA_NATIVE, tokenOut: USDC, fee: FEE, amountIn: AMOUNT_WEI });
  const floor = dcaFloorFromQuote(quote.amountOut, 9_500);
  console.log(`QuoterV2: ${formatBaseUnits(AMOUNT_WEI, 18)} test ETH -> ${formatBaseUnits(quote.amountOut, 6)} USDC; floor (95%) ${formatBaseUnits(floor, 6)} USDC`);
  const P = 3600;
  const T0 = latest + 12;
  const S = T0 + 12;
  const results = [];

  // (A) selling ETH.
  {
    const owner = keys.getAccount('eip155:1');
    const rootSpec = createKernelAccountSpec({ node, index: 0n });
    const account = await rootSpec.getAddress(owner);
    if ((await node('eth_getCode', [account, 'latest'])) !== '0x') throw new Error('The dry run expects an undeployed account');
    const sessionKey = createSessionKeyAccount(generateSessionPrivateKey());
    const terms = {
      chainId: CHAIN_ID, account, router: ROUTER, tokenIn: DCA_NATIVE, tokenOut: USDC, fee: FEE,
      amountIn: AMOUNT_WEI, minimumOut: floor, periodSeconds: P, count: 4, startAt: S,
      feeBudgetWei: 50_000_000_000_000_000n, label: 'Dry run (ETH -> USDC)',
    };
    const d = describeDca(terms, { symbolIn: 'test ETH', decimalsIn: 18, symbolOut: 'USDC', decimalsOut: 6, nativeSymbol: 'test ETH' });
    console.log(`Review: ${d.sentence}`);
    for (const c of d.caveats) console.log(`  caveat: ${c}`);
    const swap = (params = {}, value = AMOUNT_WEI) => ({
      to: ROUTER,
      value,
      data: encodeDcaSwapData({
        tokenIn: WETH, tokenOut: USDC, fee: FEE, recipient: account, amountIn: AMOUNT_WEI,
        amountOutMinimum: floor, sqrtPriceLimitX96: 0n, ...params,
      }),
    });
    const other = keys.getAccount('eip155:1', 0, 6).address;
    const steps = [
      { name: 'deploy + explicit install (root)', kind: 'install', time: T0, expect: 'accepted' },
      { name: 'swap before the first slot', kind: 'swap', time: S - 1, expect: 'rejected', expectText: 'AA22', calls: () => [swap()] },
      { name: 'swap 1 at the floor', kind: 'swap', time: S, expect: 'accepted', calls: () => buildDcaSwapCalls(terms) },
      { name: 'second swap in the same slot', kind: 'swap', time: S + 5, expect: 'rejected', expectText: 'AA22', calls: () => [swap()] },
      { name: 'lower floor (floor - 1)', kind: 'swap', time: S + P, expect: 'rejected', expectText: 'CallViolatesParamRule', calls: () => [swap({ amountOutMinimum: floor - 1n })] },
      { name: 'another recipient', kind: 'swap', time: S + P + 1, expect: 'rejected', expectText: 'CallViolatesParamRule', calls: () => [swap({ recipient: other })] },
      { name: 'another tokenOut (EURC)', kind: 'swap', time: S + P + 2, expect: 'rejected', expectText: 'CallViolatesParamRule', calls: () => [swap({ tokenOut: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4' })] },
      { name: 'larger amountIn with matching value', kind: 'swap', time: S + P + 3, expect: 'rejected', expectText: 'CallViolatesValueRule', calls: () => [swap({ amountIn: AMOUNT_WEI + 1n }, AMOUNT_WEI + 1n)] },
      { name: 'larger amountIn, value unchanged', kind: 'swap', time: S + P + 4, expect: 'rejected', expectText: 'CallViolatesParamRule', calls: () => [swap({ amountIn: AMOUNT_WEI + 1n })] },
      { name: 'a price limit', kind: 'swap', time: S + P + 5, expect: 'rejected', expectText: 'CallViolatesParamRule', calls: () => [swap({ sqrtPriceLimitX96: 1n << 159n })] },
      { name: 'RESIDUAL: two in-rule swaps in ONE operation', kind: 'swap', time: S + P + 6, expect: 'accepted', calls: () => [swap(), swap()] },
      { name: 'asking 100x the quote (above the floor)', kind: 'swap', time: S + 2 * P, expect: 'reverted-in-execution', calls: () => [buildDcaSwapCall(terms, { minimumOut: quote.amountOut * 100n })] },
      { name: 'swap 4 (the slot after the reverted one)', kind: 'swap', time: S + 3 * P, expect: 'accepted', calls: () => [buildDcaSwapCall(terms, { minimumOut: dcaMinimumOutFor(terms, quote.amountOut, 100) })] },
      { name: 'one more (count used up)', kind: 'swap', time: S + 3 * P + 10, expect: 'rejected', expectText: 'PolicyFailed(3)', calls: () => [swap()] },
      { name: 'revoke (root)', kind: 'revoke', time: S + 3 * P + 11, expect: 'accepted' },
      { name: 'swap after revocation', kind: 'swap', time: S + 3 * P + 12, expect: 'rejected', calls: () => [swap()] },
    ];
    results.push(
      await simulateScenario('A (sell ETH)', {
        account, owner, rootSpec, terms, sessionKey, steps,
        stateOverrides: { [account]: { balance: '0xde0b6b3a7640000' }, [owner.address]: { balance: '0xde0b6b3a7640000' } },
      }),
    );
  }

  // (B) selling USDC for WETH.
  {
    const owner = keys.getAccount('eip155:1', 0, 1);
    const rootSpec = createKernelAccountSpec({ node, index: 0n });
    const account = await rootSpec.getAddress(owner);
    if ((await node('eth_getCode', [account, 'latest'])) !== '0x') throw new Error('The dry run expects an undeployed account');
    const usdcIn = 1_000_000n;
    const q = await quoteDcaSwap(node, { chainId: CHAIN_ID, tokenIn: USDC, tokenOut: WETH, fee: FEE, amountIn: usdcIn });
    const wethFloor = dcaFloorFromQuote(q.amountOut, 9_500);
    console.log(`\nQuoterV2: 1 USDC -> ${formatBaseUnits(q.amountOut, 18)} WETH; floor ${formatBaseUnits(wethFloor, 18)}`);
    const sessionKey = createSessionKeyAccount(generateSessionPrivateKey());
    const terms = {
      chainId: CHAIN_ID, account, router: ROUTER, tokenIn: USDC, tokenOut: WETH, fee: FEE,
      amountIn: usdcIn, minimumOut: wethFloor, periodSeconds: P, count: 2, startAt: S,
      feeBudgetWei: 20_000_000_000_000_000n, label: 'Dry run (USDC -> WETH)',
    };
    // FiatTokenV2_2 balanceAndBlacklistStates mapping at slot 9 (as subscription-keeper.mjs).
    const usdcSlot = toHex(keccak_256(toBytes('0x' + account.slice(2).toLowerCase().padStart(64, '0') + '9'.padStart(64, '0'))));
    const [approve, swapCall] = buildDcaSwapCalls(terms);
    const bigApprove = { ...approve, data: toBytes('0x095ea7b3' + ROUTER.slice(2).toLowerCase().padStart(64, '0') + (usdcIn + 1n).toString(16).padStart(64, '0')) };
    const steps = [
      { name: 'deploy + explicit install (root)', kind: 'install', time: T0, expect: 'accepted' },
      { name: 'approve exactly 1 USDC + swap 1', kind: 'swap', time: S, expect: 'accepted', calls: () => [approve, swapCall] },
      { name: 'approve 1.000001 USDC + swap', kind: 'swap', time: S + P, expect: 'rejected', expectText: 'CallViolatesParamRule', calls: () => [bigApprove, swapCall] },
      { name: 'approve + swap 2', kind: 'swap', time: S + P + 1, expect: 'accepted', calls: () => [approve, swapCall] },
    ];
    results.push(
      await simulateScenario('B (sell USDC)', {
        account, owner, rootSpec, terms, sessionKey, steps,
        stateOverrides: {
          [account]: { balance: '0xde0b6b3a7640000' },
          [owner.address]: { balance: '0xde0b6b3a7640000' },
          [USDC]: { stateDiff: { [usdcSlot]: '0x' + (100_000_000n).toString(16).padStart(64, '0') } },
        },
      }),
    );
  }
  if (results.some((r) => r.failed)) throw new Error('Dry run expectations not met');
  console.log('\nDRY RUN PASSED. Nothing was signed with dev keys and nothing was broadcast.');
  console.log('Note the RESIDUAL step: the account accepted two in-rule swaps in one operation (the batching limit).');
}

// ---------------------------------------------------------------------------
// LIVE
// ---------------------------------------------------------------------------

function bundler() {
  return (method, params) => rawRpc(BUNDLER_URL, method, params);
}

/** A bundler that refuses to submit: a negative test can never broadcast. */
function noSendBundler() {
  const inner = bundler();
  return async (method, params) => {
    if (method === 'eth_sendUserOperation') throw new Error('NEGATIVE-TEST-NOT-SUBMITTED');
    return inner(method, params);
  };
}

async function fees() {
  const f = await nodeClient.suggestFees();
  try {
    const price = await bundler()('pimlico_getUserOperationGasPrice', []);
    const s = price?.standard;
    if (s) {
      f.maxFeePerGas = [f.maxFeePerGas, BigInt(s.maxFeePerGas)].reduce((a, b) => (a > b ? a : b));
      f.maxPriorityFeePerGas = [f.maxPriorityFeePerGas, BigInt(s.maxPriorityFeePerGas)].reduce((a, b) => (a > b ? a : b));
    }
  } catch {
    // Not served: the node's suggestion stands.
  }
  return f;
}

async function receipt(client, userOpHash) {
  const r = await client.waitForReceipt(userOpHash, { timeoutMs: 300_000, pollMs: 4_000 });
  const tx = r?.receipt?.transactionHash ?? null;
  const block = r?.receipt?.blockNumber !== undefined ? Number(BigInt(r.receipt.blockNumber)) : null;
  const logs = r?.receipt?.logs ?? r?.logs ?? [];
  const event = userOpEvent(logs, userOpHash);
  let status = null;
  let blockTime = null;
  if (tx) {
    const rc = await node('eth_getTransactionReceipt', [tx]);
    status = rc?.status ?? null;
    const b = await node('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
    blockTime = Number(BigInt(b.timestamp));
  }
  return { tx, block, blockTime, status, logs, success: event?.success ?? false, actualGasCost: event?.actualGasCost, actualGasUsed: event?.actualGasUsed };
}

async function topUpIfNeeded(owner, account, run) {
  const balance = BigInt(await node('eth_getBalance', [account, 'latest']));
  const deposit = await entryPointDeposit(account);
  console.log(`Account ${account}: ${formatBaseUnits(balance, 18)} ETH + EntryPoint deposit ${formatBaseUnits(deposit, 18)}`);
  if (balance + deposit >= TOP_UP_BELOW_WEI) return null;
  if (TOP_UP_WEI === 0n) {
    console.log('  below the top-up threshold, but DCA_TOP_UP_WEI=0: no top-up.');
    return null;
  }
  const payer = owner; // the dev EOA is the owner (index 0 of the dev seed)
  if (payer.address.toLowerCase() !== DEV_EOA.toLowerCase()) throw new Error('The owner is not the dev EOA');
  if (TOP_UP_WEI <= 0n || TOP_UP_WEI > MAX_TOP_UP_WEI) throw new Error('DCA_TOP_UP_WEI must be between 1 wei and 0.005 ETH');
  const value = TOP_UP_WEI;
  const f = await nodeClient.suggestFees();
  const estimate = await nodeClient.estimateGas({ from: payer.address, to: account, value });
  const tx = {
    chainId: CHAIN_ID,
    nonce: await nodeClient.getTransactionCount(payer.address),
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    maxFeePerGas: f.maxFeePerGas,
    gasLimit: (estimate * 120n) / 100n,
    to: account,
    value,
  };
  const hash = await nodeClient.sendRawTransaction(signEip1559(tx, payer).rawHex);
  console.log(`Top-up ${formatBaseUnits(value, 18)} ETH dev EOA -> account: tx ${hash} (gas estimate ${estimate})`);
  for (let i = 0; i < 60; i++) {
    const rc = await node('eth_getTransactionReceipt', [hash]);
    if (rc) {
      const fee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
      console.log(`  status ${rc.status} block ${Number(BigInt(rc.blockNumber))} gasUsed ${BigInt(rc.gasUsed)} fee ${fee} wei`);
      if (rc.status !== '0x1') throw new Error('Top-up failed');
      run.topUp = { tx: hash, block: Number(BigInt(rc.blockNumber)), value, gasUsed: BigInt(rc.gasUsed), feeWei: fee };
      return run.topUp;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Top-up receipt not seen within 4 minutes');
}

async function waitUntil(t, why) {
  for (;;) {
    const now = await chainTime();
    if (now >= t) return now;
    console.log(`  waiting for ${why}: chain time ${now}, target ${t} (${t - now} s)`);
    await new Promise((r) => setTimeout(r, Math.min(t - now + 2, 30) * 1000));
  }
}

/** A signed op with fixed gas for a decoded handleOps eth_call (never submitted). */
async function simulateDirect(account, spec, session, calls) {
  const nonceKey = spec.getNonceKey();
  const nonceWord = await node('eth_call', [
    { to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('getNonce(address,uint192)', [{ kind: 'address', value: account }, { kind: 'uint256', value: nonceKey }])) },
    'latest',
  ]);
  const f = await fees();
  let op = {
    sender: account,
    nonce: BigInt(nonceWord),
    callData: encodeKernelExecute(calls),
    callGasLimit: 400_000n,
    verificationGasLimit: 600_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: f.maxFeePerGas,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    signature: new Uint8Array(0),
  };
  op = sign(op, session, spec);
  try {
    await node('eth_call', [{ from: session.address, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, session.address)), gas: '0x989680' }, 'latest']);
    return 'handleOps eth_call SUCCEEDED (the account would accept it)';
  } catch (error) {
    return describeRevert(error.data ?? (/(0x[0-9a-fA-F]{8,})/.exec(error.message) ?? [])[1]);
  }
}

async function negative(name, record, session, calls) {
  const spec = kernelSessionSpec({ account: record.account, sessionKey: session.address, permissionId: record.permissionId });
  const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: noSendBundler(), node, spec, gasPaddingPct: PADDING });
  const out = { name, chainTime: await chainTime() };
  try {
    await client.sendCalls(session, calls, await fees());
    out.outcome = 'UNEXPECTED: sendCalls returned';
  } catch (error) {
    if (/NEGATIVE-TEST-NOT-SUBMITTED/.test(error.message)) {
      out.outcome = 'estimate passed; NOT submitted (bundler wrapper)';
    } else {
      out.outcome = 'refused at the bundler estimate';
      out.bundlerText = mask(error.message);
      out.decoded = decodeErrorText(error);
    }
  }
  out.handleOpsSimulation = await simulateDirect(record.account, spec, session, calls);
  console.log(`NEGATIVE ${name}: ${out.outcome}${out.decoded?.length ? ' [' + out.decoded.join('; ') + ']' : ''}; handleOps: ${out.handleOpsSimulation}`);
  if (out.bundlerText) console.log(`  bundler: ${out.bundlerText.slice(0, 400)}`);
  return out;
}

function save(run) {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(RUN_FILE, JSON.stringify(run, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}

async function live() {
  await requireSepolia();
  await verifyKernelDeployment(node);
  await checkVenue();
  const run = { startedAt: new Date().toISOString(), steps: [] };
  const keys = keyring(readFileSync(new URL('mnemonic.txt', DEV), 'utf8').trim());
  const owner = keys.getAccount('eip155:1');
  const rootSpec = createKernelAccountSpec({ node, index: LIVE_INDEX });
  const account = await rootSpec.getAddress(owner);
  if (account.toLowerCase() !== LIVE_ACCOUNT.toLowerCase()) throw new Error(`Account ${account} is not ${LIVE_ACCOUNT}`);
  if ((await node('eth_getCode', [account, 'latest'])) === '0x') throw new Error('The account must be deployed');
  run.account = account;
  await topUpIfNeeded(owner, account, run);
  save(run);
  const rootClient = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: bundler(), node, spec: rootSpec, gasPaddingPct: PADDING });
  const installClient = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: bundler(), node, spec: rootSpec, gasPaddingPct: INSTALL_PADDING });

  // Terms from a fresh quote.
  const quote = await quoteDcaSwap(node, { chainId: CHAIN_ID, tokenIn: DCA_NATIVE, tokenOut: USDC, fee: FEE, amountIn: AMOUNT_WEI });
  const floor = dcaFloorFromQuote(quote.amountOut, 9_500);
  const f0 = await fees();
  const now = await chainTime();
  const terms = {
    chainId: CHAIN_ID, account, router: ROUTER, tokenIn: DCA_NATIVE, tokenOut: USDC, fee: FEE,
    amountIn: AMOUNT_WEI, minimumOut: floor, periodSeconds: PERIOD, count: 2, startAt: now + 90, graceSeconds: PERIOD,
    // Two swaps at a 1.5M-gas worst case each at today's fee, doubled.
    feeBudgetWei: 2n * 2n * 1_500_000n * f0.maxFeePerGas,
    label: 'DCA live test (ETH -> USDC)',
  };
  run.quote = { amountIn: AMOUNT_WEI, amountOut: quote.amountOut, gasEstimate: quote.gasEstimate, floor };
  run.terms = serializeDcaTerms(terms);
  const d = describeDca(terms, { symbolIn: 'test ETH', decimalsIn: 18, symbolOut: 'USDC', decimalsOut: 6, nativeSymbol: 'test ETH' });
  console.log(`QuoterV2: ${formatBaseUnits(AMOUNT_WEI, 18)} test ETH -> ${formatBaseUnits(quote.amountOut, 6)} USDC; floor 95% = ${formatBaseUnits(floor, 6)} USDC`);
  console.log(`Review: ${d.sentence}`);
  for (const c of d.caveats) console.log(`  caveat: ${c}`);
  console.log(`Fee budget ${formatBaseUnits(terms.feeBudgetWei, 18)} ETH (maxFee ${f0.maxFeePerGas} wei)`);

  // Install (root-signed), key saved first.
  if (existsSync(KEY_FILE)) throw new Error('.dev-wallet/dca-session.key exists from an earlier run; revoke that grant and delete it first.');
  const sessionPrivateKey = generateSessionPrivateKey();
  const session = createSessionKeyAccount(sessionPrivateKey);
  writeFileSync(KEY_FILE, toHex(sessionPrivateKey) + '\n', { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  sessionPrivateKey.fill(0);
  const grant = dcaGrantFor(terms, session.address, { now });
  const inst = await prepareKernelPermissionInstall(node, grant, { chainId: CHAIN_ID, account, now });
  const record = { account, permissionId: toHex(inst.permissionId), policyCount: inst.policyCount, sessionKey: session.address };
  run.permission = record;
  save(run);
  console.log(`Session key (address only) ${session.address}; permission ${record.permissionId}; installing (owner-signed)...`);
  let revokeNeeded = false;
  let installSent;
  try {
    installSent = await installClient.sendCalls(owner, inst.installCalls, await fees());
  } catch (error) {
    // Refused before submission (estimate or local checks): nothing is on-chain, so the key is useless.
    rmSync(KEY_FILE, { force: true });
    throw error;
  }
  try {
    const sent = installSent;
    const r = await receipt(installClient, sent.userOpHash);
    run.install = { signedGas: { verificationGasLimit: sent.userOp.verificationGasLimit, callGasLimit: sent.userOp.callGasLimit, preVerificationGas: sent.userOp.preVerificationGas, maxFeePerGas: sent.userOp.maxFeePerGas } };
    Object.assign(run.install, { userOpHash: sent.userOpHash, ...r, logs: undefined });
    save(run);
    console.log(`INSTALL userOp ${sent.userOpHash} tx ${r.tx} block ${r.block} status ${r.status} success ${r.success} gasUsed ${r.actualGasUsed} cost ${r.actualGasCost} wei`);
    if (!r.success) throw new Error('Install did not succeed');
    revokeNeeded = true;
    const state = await readKernelPermissionState(node, account, inst.permissionId);
    const signer = await readSessionSigner(node, account, inst.permissionId);
    const st = await readDcaState(node, terms, inst.permissionId);
    console.log(`  read back: installed=${state.installed} policies=[${state.policies.map((p) => p.policy).join(', ')}] signer=${signer}; rate limit ${json(st)}`);
    const expected = ['callPolicy', 'timestampPolicy', 'gasPolicy', 'rateLimitPolicy'].map((k) => KERNEL_PERMISSION_MODULES[k].toLowerCase());
    if (!state.installed || signer.toLowerCase() !== session.address.toLowerCase() || state.policies.map((p) => p.policy.toLowerCase()).join() !== expected.join()) {
      throw new Error('Read-back mismatch');
    }

    const spec = kernelDcaSpec({ account, sessionKey: session.address, permissionId: inst.permissionId, terms });
    const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: bundler(), node, spec, gasPaddingPct: PADDING });
    const swapOnce = async (label) => {
      const fresh = await quoteDcaSwap(node, terms);
      const minimumOut = dcaMinimumOutFor(terms, fresh.amountOut, 100);
      const calls = buildDcaSwapCalls(terms, { minimumOut });
      const usdcBefore = await usdcBalance(account);
      const ethBefore = BigInt(await node('eth_getBalance', [account, 'latest']));
      const depBefore = await entryPointDeposit(account);
      const sent = await client.sendCalls(session, calls, await fees());
      const r = await receipt(client, sent.userOpHash);
      const o = decodeDcaOutcome(terms, r.logs, { userOpHash: sent.userOpHash });
      const blockTag = '0x' + r.block.toString(16);
      const usdcAfter = await usdcBalance(account, blockTag);
      const step = {
        name: label, userOpHash: sent.userOpHash, tx: r.tx, block: r.block, blockTime: r.blockTime, status: r.status, success: r.success,
        actualGasUsed: r.actualGasUsed, actualGasCost: r.actualGasCost,
        signedGas: { verificationGasLimit: sent.userOp.verificationGasLimit, callGasLimit: sent.userOp.callGasLimit, preVerificationGas: sent.userOp.preVerificationGas, maxFeePerGas: sent.userOp.maxFeePerGas },
        quoteAtSend: fresh.amountOut, minimumOutAsked: minimumOut, floor,
        swapEvents: o.swaps.length, amountIn: o.amountIn, amountOut: o.amountOut, usdcTransferToAccount: o.tokenOutReceived,
        usdcBalanceDelta: usdcAfter - usdcBefore, atOrAboveFloor: o.atOrAboveFloor,
        ethBefore, depositBefore: depBefore,
        ethAfter: BigInt(await node('eth_getBalance', [account, blockTag])), depositAfter: await entryPointDeposit(account, blockTag),
      };
      run.steps.push(step);
      save(run);
      console.log(
        `${label.toUpperCase()} userOp ${sent.userOpHash} tx ${r.tx} block ${r.block} status ${r.status} success ${r.success}; ` +
          `sold ${o.amountIn} wei, received ${formatBaseUnits(o.amountOut, 6)} USDC (quote at send ${formatBaseUnits(fresh.amountOut, 6)}, ` +
          `asked >= ${formatBaseUnits(minimumOut, 6)}, floor ${formatBaseUnits(floor, 6)}); USDC balance +${usdcAfter - usdcBefore}; ` +
          `gasUsed ${r.actualGasUsed} cost ${r.actualGasCost} wei`,
      );
      if (!r.success || o.swaps.length !== 1 || !o.atOrAboveFloor) throw new Error(`${label} did not succeed as expected`);
      return step;
    };

    await waitUntil(terms.startAt, 'slot 1');
    await swapOnce('swap 1');
    const s1 = await readDcaState(node, terms, inst.permissionId);
    console.log(`  after swap 1: ${json(nextPullAllowedAt(s1, await chainTime()))}; fee budget left ${s1.feeBudgetLeftWei}`);

    // Negatives, never submitted.
    const over = { ...buildDcaSwapCall(terms), value: AMOUNT_WEI + 1n };
    over.data = encodeDcaSwapData({ tokenIn: WETH, tokenOut: USDC, fee: FEE, recipient: account, amountIn: AMOUNT_WEI + 1n, amountOutMinimum: floor, sqrtPriceLimitX96: 0n });
    run.steps.push(await negative('over-amount swap (amountIn + 1 wei, value + 1 wei)', record, session, [over]));
    run.steps.push(await negative('early second swap (slot 2 not open)', record, session, buildDcaSwapCalls(terms)));
    save(run);

    await waitUntil(terms.startAt + PERIOD, 'slot 2');
    await swapOnce('swap 2');
    const s2 = await readDcaState(node, terms, inst.permissionId);
    console.log(`  after swap 2: ${json(nextPullAllowedAt(s2, await chainTime()))}; fee budget left ${s2.feeBudgetLeftWei}`);
    run.afterSwaps = s2;
  } finally {
    if (revokeNeeded) {
      console.log('Revoking (owner-signed)...');
      const sent = await rootClient.sendCalls(owner, [permissionRevokeCall(account, inst.permissionId, inst.policyCount)], await fees());
      const r = await receipt(rootClient, sent.userOpHash);
      const state = await readKernelPermissionState(node, account, inst.permissionId);
      run.revoke = { userOpHash: sent.userOpHash, tx: r.tx, block: r.block, status: r.status, success: r.success, actualGasUsed: r.actualGasUsed, actualGasCost: r.actualGasCost, installedAfter: state.installed };
      save(run);
      console.log(`REVOKE userOp ${sent.userOpHash} tx ${r.tx} block ${r.block} status ${r.status} success ${r.success}; installed afterwards ${state.installed}; cost ${r.actualGasCost} wei`);
      if (r.success && !state.installed) {
        run.steps.push(await negative('swap after revocation', record, session, [buildDcaSwapCall(terms)]));
        rmSync(KEY_FILE, { force: true });
        console.log('Session key file deleted (the grant is revoked).');
      }
    }
  }
  run.finishedAt = new Date().toISOString();
  run.accountAfter = {
    eth: BigInt(await node('eth_getBalance', [account, 'latest'])),
    deposit: await entryPointDeposit(account),
    usdc: await usdcBalance(account),
  };
  save(run);
  console.log(`\nLIVE RUN DONE. Account now ${formatBaseUnits(run.accountAfter.eth, 18)} ETH + deposit ${formatBaseUnits(run.accountAfter.deposit, 18)}, ${formatBaseUnits(run.accountAfter.usdc, 6)} USDC.`);
  console.log('Results: scripts/testnet/runs/dca-run.json');
}

(LIVE ? live() : dryRun()).catch((error) => {
  console.error(`FAILED: ${mask(error.stack ?? error.message)}`);
  process.exit(1);
});

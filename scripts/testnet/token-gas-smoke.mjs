/**
 * Pay a smart-account operation's network fee in USDC (phase 13 item 2,
 * feature 16), through Circle's permissionless token paymaster for
 * EntryPoint v0.7 and a Kernel v3.3 account. Engine code under test:
 * packages/chains-evm/src/token-paymaster.ts.
 *
 * WHICH CHAIN. Circle documents its EntryPoint v0.7 paymaster
 * 0x31BE08D380A21fc740883c0BC434FcFc88740b58 on Arbitrum Sepolia and Base
 * Sepolia only (developers.circle.com/paymaster/addresses-and-events.md,
 * fetched 2026-10-04). On Ethereum Sepolia the same address holds a proxy
 * whose entryPoint() reverts and whose EntryPoint v0.7 deposit is zero, so
 * the Circle path of this script runs on Base Sepolia (chain 84532, the
 * default) and Arbitrum Sepolia (CHAIN_ID=421614); with CHAIN_ID=11155111 it
 * prints that on-chain evidence and runs the Pimlico section instead.
 *
 * DRY RUN (default; read-only, anyone can run it, nothing is broadcast):
 *   One eth_simulateV1 request per case against the REAL contracts of the
 *   chosen chain (EntryPoint v0.7, Kernel v3.3, Circle's paymaster, USDC, the
 *   paymaster's oracle). The account's USDC balance is supplied by a state
 *   override of USDC's balance mapping (slot 9, FiatToken v2.2
 *   balanceAndBlacklistStates); the script first proves the slot by reading
 *   balanceOf under the same override. The owner is the PUBLIC BIP-39 test
 *   mnemonic, whose Kernel account is undeployed, so the simulated operation
 *   also deploys the account: deployment, the USDC permit (an ERC-1271
 *   signature by the new account), the prefund pull, the account's call and
 *   the paymaster's refund all happen in one operation, with the account
 *   holding no ETH at all. Set DRY_RUN_OWNER=dev to simulate the dev seed's
 *   deployed account instead (still read-only).
 *   Cases: (1) permit mode succeeds; (2) the balance is one base unit short
 *   of the worst-case charge -> refused in validation; (3) allowance mode
 *   with no approval -> refused; (4) a permit one unit below the prefund ->
 *   refused; (5) the engine's own pre-check refuses an insufficient balance
 *   before anything is signed.
 *
 * LIVE (TOKEN_GAS_LIVE=1; Base Sepolia or Arbitrum Sepolia; uses the
 * git-ignored dev seed):
 *   The dev seed's index-0 Kernel account 0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC
 *   (the same CREATE2 address on every chain; deployed on Base Sepolia in
 *   phase 12, on Arbitrum Sepolia by kernel-smoke.mjs in phase 15) pays for
 *   one UserOperation (a 0-value call to the owner EOA) in USDC through
 *   ZeroDev's bundler. If the account is NOT yet deployed on the chain, the
 *   same operation deploys it: SmartAccountClient adds the factory fields,
 *   the EntryPoint creates the account before validation, and the USDC
 *   permit (an ERC-1271 signature by the new account) is checked after the
 *   account exists — the path dry-run case 1 proves with the public test
 *   mnemonic's undeployed account holding no ETH at all. No ETH is needed in
 *   the account on either path. If the account holds less than
 *   TOKEN_GAS_MIN_USDC (default 0.5 USDC), the dev EOA first transfers
 *   TOKEN_GAS_FUND_USDC (default 1 USDC) of its own USDC on that chain with
 *   an engine-signed EIP-1559 transaction (simulated with eth_call first,
 *   gas estimated). Before the real operation, two refusals are
 *   obtained from the real bundler's estimation (read-only): allowance mode
 *   with no approval, and an account holding no USDC (index 1,
 *   counterfactual). Afterwards every claim is checked from chain state at
 *   the including block and the block before it: the account's ETH balance
 *   and EntryPoint deposit unchanged, the USDC debit equal to the
 *   paymaster's UserOperationSponsored.actualTokenNeeded, the
 *   UserOperationEvent naming the paymaster, the paymaster's own deposit
 *   paying the gas, and the allowance left at zero.
 *
 * Environment:
 *   CHAIN_ID              84532 (default), 421614 (Arbitrum Sepolia, Circle's
 *                         paymaster there) or 11155111 (Ethereum Sepolia:
 *                         Pimlico's ERC-20 paymaster over ERC-7677, see the
 *                         section near the end of this file).
 *   NODE_URL              optional; default the first RPC of the app's profile
 *                         (https://base-sepolia-rpc.publicnode.com,
 *                         https://arbitrum-sepolia-rpc.publicnode.com, or
 *                         config.mjs SEPOLIA_RPC).
 *   TOKEN_GAS_LIVE=1      live mode (needs ZERODEV_PROJECT_ID or BUNDLER_URL).
 *   ZERODEV_PROJECT_ID    bundler https://rpc.zerodev.app/api/v3/{id}/chain/{CHAIN_ID};
 *                         never printed (masked as <masked>).
 *   DRY_RUN_OWNER=dev     dry run with the dev seed's deployed account.
 *
 * Run from the repository root after `npm run build`:
 *   node scripts/testnet/token-gas-smoke.mjs                         # dry run
 *   set -a; . .dev-wallet/env; set +a
 *   TOKEN_GAS_LIVE=1 node scripts/testnet/token-gas-smoke.mjs        # one live op
 *   CHAIN_ID=421614 TOKEN_GAS_LIVE=1 node scripts/testnet/token-gas-smoke.mjs  # on Arbitrum Sepolia
 */
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  CIRCLE_TOKEN_PAYMASTER_V07,
  ENTRYPOINT_V07,
  PIMLICO_ERC20_PAYMASTER_V07,
  TokenGasChargeAboveLimitError,
  createErc7677TokenPaymasterTransport,
  decodePimlicoSponsoredEvents,
  encodePimlicoErc20PaymasterData,
  erc7677MaxTokenCharge,
  erc7677TokenApproveCall,
  parsePimlicoErc20PaymasterData,
  pimlicoErc20PaymasterHash,
  pimlicoPaymasterProblems,
  readPimlicoPaymasterState,
  toEthSignedMessageHash,
  withEthereumV,
  NodeClient,
  SmartAccountClient,
  TokenGasInsufficientBalanceError,
  buildTokenPermit,
  createCirclePaymasterTransport,
  createKernelAccountSpec,
  decodeCircleSponsoredEvents,
  encodeCirclePaymasterData,
  encodeErc20Transfer,
  encodeFunctionCall,
  getUserOpHash,
  httpTransport,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  readCirclePaymasterState,
  readTokenBalanceAndAllowance,
  readTokenPermitInfo,
  signEip1559,
  toBytes,
  toHex,
  toRpcUserOperation,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const LIVE = process.env.TOKEN_GAS_LIVE === '1';
const CHAIN_ID = BigInt(process.env.CHAIN_ID ?? '84532');
const NODE_URL =
  process.env.NODE_URL ??
  (CHAIN_ID === 11155111n
    ? SEPOLIA_RPC
    : CHAIN_ID === 421614n
      ? 'https://arbitrum-sepolia-rpc.publicnode.com'
      : 'https://base-sepolia-rpc.publicnode.com');
const CHAIN_NAMES = { '84532': 'Base Sepolia', '421614': 'Arbitrum Sepolia', '11155111': 'Ethereum Sepolia' };
const CHAIN_NAME = CHAIN_NAMES[CHAIN_ID.toString()] ?? `chain ${CHAIN_ID}`;
const PAYMASTER = CIRCLE_TOKEN_PAYMASTER_V07.testnetAddress;
// Circle's chains (Base Sepolia, Arbitrum Sepolia); on Ethereum Sepolia the
// Pimlico section below uses its own constant.
const USDC = CIRCLE_TOKEN_PAYMASTER_V07.tokens[CHAIN_ID.toString()] ?? CIRCLE_TOKEN_PAYMASTER_V07.tokens['84532'];
/** FiatToken v2.2 balanceAndBlacklistStates mapping slot (proved by an override read below). */
const USDC_BALANCE_SLOT = 9n;
const DEV_ACCOUNT = '0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC';
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID
    ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/${CHAIN_ID}`
    : undefined);

function mask(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) {
    out = out.split(secret).join('<masked>');
  }
  return out;
}
const log = (...parts) => console.log(...parts.map(mask));

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);

const topic = (sig) => toHex(keccak_256(utf8ToBytes(sig)));
const USER_OPERATION_EVENT = topic('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
const ACCOUNT_DEPLOYED = topic('AccountDeployed(bytes32,address,address,address)');
const TRANSFER = topic('Transfer(address,address,uint256)');
const HANDLE_OPS_SIG =
  'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';
const ERRORS = Object.fromEntries(
  ['FailedOp(uint256,string)', 'FailedOpWithRevert(uint256,string,bytes)', 'PostOpReverted(bytes)'].map((s) => [
    topic(s).slice(0, 10),
    s,
  ]),
);

let failures = 0;
function check(label, ok, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const fmtUsdc = (units) => {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  return `${neg ? '-' : ''}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')} USDC (${units} base units)`;
};

function loadOwner(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');
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
  return encodeFunctionCall(HANDLE_OPS_SIG, [
    { kind: 'array', items: [packed] },
    { kind: 'address', value: beneficiary },
  ]);
}

/** Decodes FailedOp / FailedOpWithRevert (reason + inner selector). */
function describeRevert(data) {
  if (typeof data !== 'string' || data.length < 10) return `revert data ${data}`;
  const name = ERRORS[data.slice(0, 10).toLowerCase()];
  if (!name) return `revert ${data.slice(0, 10)}`;
  const body = data.slice(10);
  const w = (i) => body.slice(i * 64, i * 64 + 64);
  if (name.startsWith('PostOpReverted')) return name;
  const strOffset = Number(BigInt('0x' + w(1))) / 32;
  const strLen = Number(BigInt('0x' + w(strOffset)));
  const reason = Buffer.from(body.slice((strOffset + 1) * 64, (strOffset + 1) * 64 + strLen * 2), 'hex').toString();
  let inner = '';
  if (name.startsWith('FailedOpWithRevert')) {
    const bOffset = Number(BigInt('0x' + w(2))) / 32;
    const bLen = Number(BigInt('0x' + w(bOffset)));
    const innerData = '0x' + body.slice((bOffset + 1) * 64, (bOffset + 1) * 64 + bLen * 2);
    inner = ` inner ${innerData.slice(0, 10)}${decodeErrorString(innerData)}`;
  }
  return `${name.split('(')[0]}("${reason}")${inner}`;
}

/** Error(string) payloads, e.g. FiatToken's "ERC20: transfer amount exceeds allowance". */
function decodeErrorString(data) {
  if (!data.startsWith('0x08c379a0')) return '';
  const body = data.slice(10);
  const len = Number(BigInt('0x' + body.slice(64, 128)));
  return ` "${Buffer.from(body.slice(128, 128 + len * 2), 'hex').toString()}"`;
}

function balanceSlotKey(holder) {
  const preimage = new Uint8Array(64);
  preimage.set(toBytes(holder), 12);
  preimage.set(toBytes('0x' + USDC_BALANCE_SLOT.toString(16).padStart(64, '0')), 32);
  return toHex(keccak_256(preimage));
}

function word(value) {
  return '0x' + value.toString(16).padStart(64, '0');
}

/** A node transport whose eth_call reads see the given state overrides (geth's third parameter). */
function overriddenNode(stateOverrides) {
  return async (method, params) => {
    if (method === 'eth_call') return node('eth_call', [params[0], params[1] ?? 'latest', stateOverrides]);
    return node(method, params);
  };
}

async function main() {
  const chainId = await nodeClient.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`The node reports chain ${chainId}, expected ${CHAIN_ID}`);
  if (chainId === 11155111n) {
    await sepoliaEvidence();
    return pimlicoSepolia();
  }
  if (chainId !== 84532n && chainId !== 421614n) throw new Error('Base Sepolia (84532) or Arbitrum Sepolia (421614) only');
  const state = await readCirclePaymasterState(node, PAYMASTER);
  log(`Circle paymaster ${PAYMASTER}: entryPoint ${state.entryPoint}, token ${state.token}, ` +
    `price ${state.nativeTokenPrice} base units per ETH, additionalGasCharge ${state.additionalGasCharge}, ` +
    `feeSpread ${state.feeSpreadBips} bps, paused ${state.paused}, implementation ${state.implementation}, ` +
    `deposit ${state.deposit} wei, staked ${state.staked} (${state.stake} wei, ${state.unstakeDelaySec} s)`);
  if (LIVE) return live(state);
  return dryRun(state);
}

async function sepoliaEvidence() {
  const ep = await node('eth_call', [{ to: PAYMASTER, data: toHex(encodeFunctionCall('entryPoint()', [])) }, 'latest']).catch(
    (e) => `reverted (${e.message})`,
  );
  const deposit = await node('eth_call', [
    { to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: PAYMASTER }])) },
    'latest',
  ]);
  log(`Ethereum Sepolia: ${PAYMASTER} entryPoint() -> ${ep}; EntryPoint v0.7 deposit ${BigInt(deposit)} wei.`);
  log('Circle documents no EntryPoint v0.7 paymaster on Ethereum Sepolia; the Sepolia run below uses Pimlico’s ERC-20 paymaster over ERC-7677.');
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function simulate(op, overrides, beneficiary, extraCalls = []) {
  const calls = [
    { from: beneficiary, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, beneficiary)), gas: '0x1c9c380' },
    ...extraCalls,
  ];
  const [block] = await node('eth_simulateV1', [
    { blockStateCalls: [{ stateOverrides: overrides, calls }], traceTransfers: true, validation: false },
    'latest',
  ]);
  return block.calls;
}

async function buildOp({ spec, owner, account, deployed, nonce, fees, callData, paymasterFields }) {
  const factoryArgs = deployed ? undefined : await spec.getFactoryArgs(owner);
  const op = {
    sender: account,
    nonce,
    ...(factoryArgs ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData } : {}),
    callData,
    callGasLimit: 120_000n,
    verificationGasLimit: deployed ? 250_000n : 600_000n,
    preVerificationGas: 120_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: spec.stubSignature(),
    ...paymasterFields,
  };
  const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
  return { ...op, signature: await spec.signUserOpHash(owner, hash), userOpHash: toHex(hash) };
}

function paymasterFieldsFrom(result) {
  return {
    paymaster: result.paymaster,
    paymasterData: toBytes(result.paymasterData),
    paymasterVerificationGasLimit: BigInt(result.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(result.paymasterPostOpGasLimit),
  };
}

async function dryRun(state) {
  const useDev = process.env.DRY_RUN_OWNER === 'dev';
  const mnemonic = useDev
    ? readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim()
    : PUBLIC_TEST_MNEMONIC;
  const owner = loadOwner(mnemonic);
  const spec = createKernelAccountSpec({ node, index: 0n });
  const account = await spec.getAddress(owner);
  const deployed = (await node('eth_getCode', [account, 'latest'])) !== '0x';
  log(`DRY RUN (${useDev ? 'dev seed' : 'public test mnemonic'}): owner ${owner.address}, Kernel account ${account}, deployed ${deployed}`);
  const beneficiary = '0x000000000000000000000000000000000000bEEF';
  const fees = await nodeClient.suggestFees();
  // Same priority floor ZeroDev's and Alchemy's bundlers enforce on Sepolia; harmless here.
  if (fees.maxPriorityFeePerGas < 100_000_000n) {
    fees.maxFeePerGas += 100_000_000n - fees.maxPriorityFeePerGas;
    fees.maxPriorityFeePerGas = 100_000_000n;
  }
  const nonce = BigInt(
    await node('eth_call', [
      {
        to: ENTRYPOINT_V07,
        data: toHex(encodeFunctionCall('getNonce(address,uint192)', [
          { kind: 'address', value: account },
          { kind: 'uint256', value: 0n },
        ])),
      },
      'latest',
    ]),
  );
  const callData = spec.encodeCalls([{ to: owner.address, value: 0n, data: new Uint8Array(0) }]);
  const signPermit = (digest) => spec.signErc1271(owner, digest, { chainId: CHAIN_ID, account });

  const usdcFor = (amount) => ({
    [USDC]: { stateDiff: { [balanceSlotKey(account)]: word(amount) } },
    // The account holds no ETH at all in every case (an undeployed account
    // has none anyway; a deployed one is zeroed here).
    [account]: { balance: '0x0' },
    [beneficiary]: { balance: '0xde0b6b3a7640000' },
  });

  // Prove the balance slot before relying on it.
  const probeAmount = 2_000_000n;
  const probe = await readTokenBalanceAndAllowance(overriddenNode(usdcFor(probeAmount)), USDC, account, PAYMASTER);
  check('USDC balance slot 9 override is read back by balanceOf', probe.balance === probeAmount, fmtUsdc(probe.balance));

  // The engine's transport, against a node that sees the same override.
  const quotes = [];
  const transportFor = (amount, mode = 'permit') =>
    createCirclePaymasterTransport({
      node: overriddenNode(usdcFor(amount)),
      chainId: CHAIN_ID,
      account,
      token: USDC,
      mode,
      signPermit,
      onQuote: (q) => quotes.push(q),
    });
  const gasOnly = {
    sender: account,
    nonce,
    callData,
    callGasLimit: 120_000n,
    verificationGasLimit: deployed ? 250_000n : 600_000n,
    preVerificationGas: 120_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: spec.stubSignature(),
  };
  const finalData = (transport) =>
    transport('pm_getPaymasterData', [toRpcUserOperation(gasOnly), ENTRYPOINT_V07, '0x' + CHAIN_ID.toString(16), null]);

  // Case 1: permit mode, enough USDC, no ETH.
  const result = await finalData(transportFor(probeAmount));
  const quote = quotes.at(-1);
  log(`Quote: required prefund ${quote.requiredPrefundWei} wei; worst-case charge ${fmtUsdc(quote.maxTokenCharge)}; permit for ${fmtUsdc(quote.permitAmount)}`);
  const op = await buildOp({ spec, owner, account, deployed, nonce, fees, callData, paymasterFields: paymasterFieldsFrom(result) });
  const read = (to, signature, args) => ({ from: beneficiary, to, data: toHex(encodeFunctionCall(signature, args)) });
  const after = [
    read(USDC, 'balanceOf(address)', [{ kind: 'address', value: account }]),
    read(USDC, 'allowance(address,address)', [{ kind: 'address', value: account }, { kind: 'address', value: PAYMASTER }]),
    read(ENTRYPOINT_V07, 'balanceOf(address)', [{ kind: 'address', value: account }]),
  ];
  const depositBefore = BigInt(
    await node('eth_call', [read(ENTRYPOINT_V07, 'balanceOf(address)', [{ kind: 'address', value: account }]), 'latest']),
  );
  const [handle, balAfter, allowanceAfter, depositAfter] = await simulate(op, usdcFor(probeAmount), beneficiary, after);
  check('case 1 handleOps succeeds', handle.status === '0x1', handle.error ? describeRevert(handle.error.data) : '');
  const opEvent = handle.logs.find((l) => l.topics[0] === USER_OPERATION_EVENT);
  check('case 1 UserOperationEvent success', !!opEvent && BigInt('0x' + opEvent.data.slice(2 + 64, 2 + 128)) === 1n);
  check(
    'case 1 UserOperationEvent names the Circle paymaster',
    !!opEvent && opEvent.topics[3].slice(26).toLowerCase() === PAYMASTER.slice(2).toLowerCase(),
  );
  if (!deployed) check('case 1 deploys the account in the same operation', handle.logs.some((l) => l.topics[0] === ACCOUNT_DEPLOYED));
  const sponsored = decodeCircleSponsoredEvents(handle.logs);
  check('case 1 UserOperationSponsored emitted once', sponsored.length === 1);
  const charged = sponsored[0]?.actualTokenNeeded ?? -1n;
  const usdcDelta = BigInt(balAfter.returnData) - probeAmount;
  check('case 1 USDC debit equals actualTokenNeeded', usdcDelta === -charged, `${fmtUsdc(usdcDelta)}`);
  check('case 1 charge within the quoted worst case', charged > 0n && charged <= quote.maxTokenCharge, `${fmtUsdc(charged)} <= ${fmtUsdc(quote.maxTokenCharge)}`);
  check('case 1 allowance left at zero', BigInt(allowanceAfter.returnData) === 0n);
  check('case 1 account EntryPoint deposit unchanged', BigInt(depositAfter.returnData) === depositBefore, `${depositBefore} wei`);
  const ethOut = handle.logs.filter(
    (l) =>
      l.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' &&
      l.topics[1]?.slice(26).toLowerCase() === account.slice(2).toLowerCase(),
  );
  check('case 1 no ETH leaves the account (it holds none)', ethOut.length === 0);
  const usdcTransfers = handle.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.topics[0] === TRANSFER);
  log(`  USDC transfers: ${usdcTransfers.map((l) => `${l.topics[1].slice(26, 30)}…→${l.topics[2].slice(26, 30)}… ${BigInt(l.data)}`).join(', ')}`);

  // Case 2: one base unit short of the worst case -> the paymaster's transferFrom fails in validation.
  const short = quote.maxTokenCharge - 1n;
  const [r2] = await simulate(op, usdcFor(short), beneficiary);
  check('case 2 balance one unit short is refused in validation', r2.status === '0x0', r2.error ? describeRevert(r2.error.data) : 'no revert');

  // Case 3: allowance mode, no approval.
  const op3 = await buildOp({
    spec, owner, account, deployed, nonce, fees, callData,
    paymasterFields: { ...paymasterFieldsFrom(result), paymasterData: encodeCirclePaymasterData({ mode: 'allowance' }) },
  });
  const [r3] = await simulate(op3, usdcFor(probeAmount), beneficiary);
  check('case 3 allowance mode without approval is refused', r3.status === '0x0', r3.error ? describeRevert(r3.error.data) : 'no revert');

  // Case 4: a permit for one unit less than the prefund.
  const info = await readTokenPermitInfo(overriddenNode(usdcFor(probeAmount)), USDC, account, CHAIN_ID);
  const lowPermit = buildTokenPermit({ token: USDC, name: info.name, version: info.version, chainId: CHAIN_ID, owner: account, spender: PAYMASTER, value: quote.maxTokenCharge - 1n, nonce: info.nonce });
  const op4 = await buildOp({
    spec, owner, account, deployed, nonce, fees, callData,
    paymasterFields: {
      ...paymasterFieldsFrom(result),
      paymasterData: encodeCirclePaymasterData({ mode: 'permit', token: USDC, permitAmount: quote.maxTokenCharge - 1n, permitSignature: signPermit(lowPermit.digest) }),
    },
  });
  const [r4] = await simulate(op4, usdcFor(probeAmount), beneficiary);
  check('case 4 permit one unit below the prefund is refused', r4.status === '0x0', r4.error ? describeRevert(r4.error.data) : 'no revert');

  // Case 5: the engine refuses before signing anything.
  let refused = null;
  try {
    await finalData(transportFor(short));
  } catch (error) {
    refused = error;
  }
  check('case 5 engine pre-check refuses an insufficient balance', refused instanceof TokenGasInsufficientBalanceError, refused?.message ?? 'not refused');

  log(failures === 0 ? 'DRY RUN PASSED' : `DRY RUN FAILED (${failures})`);
  if (failures) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

async function bundlerRaw(method, params) {
  const response = await fetch(BUNDLER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json().catch(() => ({}));
  if (body.error) {
    const error = new Error(`RPC error ${body.error.code}: ${body.error.message} (${method})`);
    error.data = body.error.data;
    throw error;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} (${method})`);
  return body.result;
}

/**
 * A bundler gas estimate that cannot be right: account validation always
 * uses gas, and a paymaster's validation too (Circle's paymaster pulls USDC
 * and, in permit mode, verifies an ERC-1271 permit). Observed 2026-10-09 on
 * ZeroDev's Arbitrum Sepolia endpoint: eth_estimateUserOperationGas often
 * answered verificationGasLimit 0x0 (and paymasterVerificationGasLimit 0x0)
 * for a Kernel deployment op; the engine's Circle transport keeps the
 * estimate's paymasterVerificationGasLimit for the final data, so a zero
 * there would be signed. Such answers are refused and asked again.
 */
function estimateProblem(answer, op) {
  if (!answer || BigInt(answer.verificationGasLimit ?? '0x0') === 0n) {
    return 'verificationGasLimit is 0, which no account validation can use';
  }
  if (op?.paymaster && answer.paymasterVerificationGasLimit !== undefined && BigInt(answer.paymasterVerificationGasLimit) === 0n) {
    return 'paymasterVerificationGasLimit is 0 although the operation names a paymaster';
  }
  return null;
}
const ESTIMATE_ATTEMPTS = Number(process.env.ESTIMATE_ATTEMPTS ?? '24');

/** The bundler for SmartAccountClient: raw, except that impossible estimates are refused and retried. */
async function guardedBundler(method, params) {
  if (method !== 'eth_estimateUserOperationGas') return bundlerRaw(method, params);
  for (let attempt = 1; ; attempt++) {
    const answer = await bundlerRaw(method, params);
    const problem = estimateProblem(answer, params[0]);
    if (!problem) {
      log(`Bundler gas estimate (attempt ${attempt}): ${JSON.stringify(answer)}`);
      return answer;
    }
    log(`Bundler gas estimate refused (attempt ${attempt} of ${ESTIMATE_ATTEMPTS}): ${problem}; answer ${JSON.stringify(answer)}`);
    if (attempt >= ESTIMATE_ATTEMPTS) {
      throw new Error(`The bundler answered no usable gas estimate in ${ESTIMATE_ATTEMPTS} attempts (${problem}). Nothing was signed or sent.`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function waitForTx(hash) {
  for (let i = 0; i < 90; i++) {
    const receipt = await node('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

async function live(state) {
  if (!BUNDLER_URL) throw new Error('Set ZERODEV_PROJECT_ID (or BUNDLER_URL) for live mode.');
  const bundler = async (method, params) => bundlerRaw(method, params);
  const bundlerChain = BigInt(await bundler('eth_chainId', []));
  if (bundlerChain !== CHAIN_ID) throw new Error(`The bundler serves chain ${bundlerChain}`);
  const owner = loadOwner(readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim());
  const spec = createKernelAccountSpec({ node, index: 0n });
  const account = await spec.getAddress(owner);
  if (account.toLowerCase() !== DEV_ACCOUNT.toLowerCase()) throw new Error(`Unexpected account ${account}`);
  // An undeployed account is deployed by this same operation (see the header;
  // dry-run case 1 proves the path), so no separate deployment is needed.
  const deployedBefore = (await node('eth_getCode', [account, 'latest'])) !== '0x';
  log(`LIVE on ${CHAIN_NAME}: owner ${owner.address}, Kernel account ${account} ` +
    `(${deployedBefore ? 'deployed' : 'NOT deployed: this operation deploys it'}), bundler ${BUNDLER_URL}`);
  const signPermit = (digest) => spec.signErc1271(owner, digest, { chainId: CHAIN_ID, account });

  // Fees from the bundler (ZeroDev serves pimlico_getUserOperationGasPrice), else the node.
  let fees;
  try {
    const answer = await bundler('pimlico_getUserOperationGasPrice', []);
    fees = { maxFeePerGas: BigInt(answer.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(answer.standard.maxPriorityFeePerGas) };
  } catch {
    fees = await nodeClient.suggestFees();
  }
  log(`Fees: maxFeePerGas ${fees.maxFeePerGas}, maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}`);

  // 1. Make sure the account holds some USDC (from the dev EOA's own USDC on this chain).
  const minUsdc = BigInt(process.env.TOKEN_GAS_MIN_USDC ?? '500000');
  const fundUsdc = BigInt(process.env.TOKEN_GAS_FUND_USDC ?? '1000000');
  let { balance } = await readTokenBalanceAndAllowance(node, USDC, account, PAYMASTER);
  log(`Account USDC: ${fmtUsdc(balance)}`);
  if (balance < minUsdc) {
    const data = encodeErc20Transfer(account, fundUsdc);
    await node('eth_call', [{ from: owner.address, to: USDC, data: toHex(data) }, 'latest']); // simulate first
    const gas = BigInt(await node('eth_estimateGas', [{ from: owner.address, to: USDC, data: toHex(data) }]));
    const nodeFees = await nodeClient.suggestFees();
    const tx = signEip1559(
      {
        chainId: CHAIN_ID,
        nonce: await nodeClient.getTransactionCount(owner.address),
        maxPriorityFeePerGas: nodeFees.maxPriorityFeePerGas,
        maxFeePerGas: nodeFees.maxFeePerGas,
        gasLimit: (gas * 130n) / 100n,
        to: USDC,
        value: 0n,
        data,
      },
      owner,
    );
    const hash = await nodeClient.sendRawTransaction(tx.rawHex);
    log(`USDC funding transfer ${fmtUsdc(fundUsdc)} dev EOA -> account: ${hash}`);
    const receipt = await waitForTx(hash);
    check('funding transfer status 1', receipt.status === '0x1', `block ${BigInt(receipt.blockNumber)}`);
    ({ balance } = await readTokenBalanceAndAllowance(node, USDC, account, PAYMASTER));
    log(`Account USDC now ${fmtUsdc(balance)}`);
  }

  const callData = spec.encodeCalls([{ to: owner.address, value: 0n, data: new Uint8Array(0) }]);
  const nonce = await new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node, spec }).getNonce(owner);

  // 2. Refusals from the real bundler's estimation (read-only).
  const stubOp = (sender, paymasterData, extra = {}) => ({
    sender,
    nonce: extra.nonce ?? nonce,
    ...extra.factory,
    callData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: CIRCLE_TOKEN_PAYMASTER_V07.defaultVerificationGasLimit,
    paymasterPostOpGasLimit: CIRCLE_TOKEN_PAYMASTER_V07.defaultPostOpGasLimit,
    paymasterData,
    signature: spec.stubSignature(),
  });
  try {
    const answer = await bundler('eth_estimateUserOperationGas', [
      toRpcUserOperation(stubOp(account, encodeCirclePaymasterData({ mode: 'allowance' }))),
      ENTRYPOINT_V07,
    ]);
    check('bundler refuses allowance mode without approval', false, `estimate answered ${JSON.stringify(answer)}`);
  } catch (error) {
    check('bundler refuses allowance mode without approval', true, error.message);
  }
  const emptySpec = createKernelAccountSpec({ node, index: 1n });
  const emptyAccount = await emptySpec.getAddress(owner);
  const emptyHolds = (await readTokenBalanceAndAllowance(node, USDC, emptyAccount, PAYMASTER)).balance;
  if (emptyHolds === 0n && (await node('eth_getCode', [emptyAccount, 'latest'])) === '0x') {
    const factoryArgs = await emptySpec.getFactoryArgs(owner);
    const emptyTransport = createCirclePaymasterTransport({
      node, chainId: CHAIN_ID, account: emptyAccount, token: USDC, mode: 'permit',
      signPermit: (digest) => emptySpec.signErc1271(owner, digest, { chainId: CHAIN_ID, account: emptyAccount }),
    });
    const stubResult = await emptyTransport('pm_getPaymasterStubData', [
      toRpcUserOperation(stubOp(emptyAccount, new Uint8Array(0), { nonce: 0n })), ENTRYPOINT_V07, '0x' + CHAIN_ID.toString(16), null,
    ]);
    try {
      const answer = await bundler('eth_estimateUserOperationGas', [
        toRpcUserOperation({
          ...stubOp(emptyAccount, toBytes(stubResult.paymasterData), {
            nonce: 0n,
            factory: { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData },
          }),
          callData: emptySpec.encodeCalls([{ to: owner.address, value: 0n, data: new Uint8Array(0) }]),
        }),
        ENTRYPOINT_V07,
      ]);
      check('bundler refuses an account without USDC', false, `estimate answered ${JSON.stringify(answer)}`);
    } catch (error) {
      check('bundler refuses an account without USDC', true, `${emptyAccount}: ${error.message}`);
    }
  } else {
    log(`Skipped the no-USDC refusal: ${emptyAccount} is deployed or holds USDC.`);
  }

  // 3. The real operation, through SmartAccountClient's unchanged ERC-7677 seam.
  const quotes = [];
  const client = new SmartAccountClient({
    chainId: CHAIN_ID,
    entryPoint: ENTRYPOINT_V07,
    bundler: guardedBundler,
    node,
    spec,
    paymaster: {
      transport: createCirclePaymasterTransport({
        node, chainId: CHAIN_ID, account, token: USDC, mode: 'permit', signPermit,
        onQuote: (q) => quotes.push(q),
      }),
    },
    gasPaddingPct: { verification: 110, call: 130, preVerification: 105 },
  });
  const { userOpHash, userOp } = await client.sendCalls(owner, [{ to: owner.address, value: 0n, data: new Uint8Array(0) }], fees);
  const stub = quotes.find((q) => q.phase === 'stub');
  const final = quotes.find((q) => q.phase === 'final');
  log(`Stub permit (estimation only): ${fmtUsdc(stub.permitAmount)}`);
  log(`Final worst-case charge: ${fmtUsdc(final.maxTokenCharge)} (required prefund ${final.requiredPrefundWei} wei at price ${final.nativeTokenPrice}); permit ${fmtUsdc(final.permitAmount)}`);
  log(`UserOperation accepted by the bundler: ${userOpHash}`);
  const opReceipt = await client.waitForReceipt(userOpHash, { timeoutMs: 180_000, pollMs: 4_000 });
  const txHash = opReceipt?.receipt?.transactionHash;
  log(`Bundle transaction: ${txHash}`);
  const receipt = await waitForTx(txHash);
  const block = BigInt(receipt.blockNumber);
  check('bundle transaction status 1', receipt.status === '0x1', `block ${block}`);
  const opEvent = receipt.logs.find((l) => l.topics[0] === USER_OPERATION_EVENT && l.topics[1] === userOpHash);
  check('UserOperationEvent success', !!opEvent && BigInt('0x' + opEvent.data.slice(2 + 64, 2 + 128)) === 1n);
  check('UserOperationEvent paymaster is Circle', !!opEvent && opEvent.topics[3].slice(26).toLowerCase() === PAYMASTER.slice(2).toLowerCase());
  const deployedEvent = receipt.logs.some((l) => l.topics[0] === ACCOUNT_DEPLOYED && l.topics[1] === userOpHash);
  if (deployedBefore) check('no AccountDeployed (the account already existed)', !deployedEvent);
  else check('AccountDeployed in the same operation', deployedEvent);
  if (opEvent) {
    log(`  UserOperationEvent: actualGasCost ${BigInt('0x' + opEvent.data.slice(2 + 128, 2 + 192))} wei, ` +
      `actualGasUsed ${BigInt('0x' + opEvent.data.slice(2 + 192, 2 + 256))}; signed preVerificationGas ${userOp.preVerificationGas}, ` +
      `verificationGasLimit ${userOp.verificationGasLimit}, callGasLimit ${userOp.callGasLimit}, ` +
      `paymasterVerificationGasLimit ${userOp.paymasterVerificationGasLimit}, paymasterPostOpGasLimit ${userOp.paymasterPostOpGasLimit}, ` +
      `maxFeePerGas ${userOp.maxFeePerGas}`);
  }
  const actualGasCost = opEvent ? BigInt('0x' + opEvent.data.slice(2 + 128, 2 + 192)) : 0n;
  const sponsored = decodeCircleSponsoredEvents(receipt.logs).filter((e) => e.userOpHash === userOpHash);
  check('UserOperationSponsored for this operation', sponsored.length === 1);
  const charged = sponsored[0]?.actualTokenNeeded ?? -1n;
  log(`  actualGasCost ${actualGasCost} wei; actualTokenNeeded ${fmtUsdc(charged)}; nativeTokenPrice ${sponsored[0]?.nativeTokenPrice}`);

  const at = (b) => '0x' + b.toString(16);
  const eth = async (b) => BigInt(await node('eth_getBalance', [account, at(b)]));
  const dep = async (who, b) => BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: who }])) }, at(b)]));
  const tok = (b) => readTokenBalanceAndAllowance(node, USDC, account, PAYMASTER, at(b));
  const [ethBefore, ethAfter, depBefore, depAfter, pmBefore, pmAfter, tokBefore, tokAfter] = await Promise.all([
    eth(block - 1n), eth(block), dep(account, block - 1n), dep(account, block), dep(PAYMASTER, block - 1n), dep(PAYMASTER, block), tok(block - 1n), tok(block),
  ]);
  check('account ETH balance unchanged', ethBefore === ethAfter, `${ethBefore} wei`);
  check('account EntryPoint deposit unchanged', depBefore === depAfter, `${depBefore} wei`);
  check('USDC debit equals actualTokenNeeded', tokBefore.balance - tokAfter.balance === charged, `${fmtUsdc(tokBefore.balance)} -> ${fmtUsdc(tokAfter.balance)}`);
  check('charge within the confirmed worst case', charged > 0n && charged <= final.maxTokenCharge);
  check('allowance left at zero', tokAfter.allowance === 0n, `before ${tokBefore.allowance}, after ${tokAfter.allowance}`);
  check('paymaster EntryPoint deposit paid the gas', pmBefore - pmAfter === actualGasCost, `${pmBefore} -> ${pmAfter} (delta ${pmBefore - pmAfter}, actualGasCost ${actualGasCost})`);
  const transfers = receipt.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.topics[0] === TRANSFER);
  for (const l of transfers) log(`  USDC Transfer 0x${l.topics[1].slice(26)} -> 0x${l.topics[2].slice(26)}: ${fmtUsdc(BigInt(l.data))}`);
  const prefundPull = transfers.find((l) => l.topics[1].slice(26).toLowerCase() === account.slice(2).toLowerCase());
  check('prefund pulled equals the permitted worst case', !!prefundPull && BigInt(prefundPull.data) === final.permitAmount);
  check('signed paymaster limits are the ones quoted', userOp.paymasterPostOpGasLimit >= state.additionalGasCharge);
  log(failures === 0 ? 'LIVE RUN PASSED' : `LIVE RUN FAILED (${failures})`);
  if (failures) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Ethereum Sepolia: Pimlico's ERC-20 paymaster over ERC-7677 (phase 14 item 3)
// ---------------------------------------------------------------------------
//
// Engine code under test: packages/chains-evm/src/erc7677-token-paymaster.ts.
// The paymaster is Pimlico's SingletonPaymasterV7 at
// 0x777777777777AeC03fd955926DbF81597e66834C (docs.pimlico.io contract
// addresses page; Sourcify exact match on chain 11155111). The exchange rate
// and Pimlico's signature come from the ERC-7677 endpoint (ZeroDev's project
// RPC forwards pm_getPaymasterStubData / pm_getPaymasterData with the context
// {token} to Pimlico's paymaster). The account approves the paymaster for
// EXACTLY the displayed maximum in the same operation; postOp takes the cost.
//
// DRY RUN (default; read-only): one eth_simulateV1 per case against the real
// Sepolia contracts. Two state overrides are used, each proved by a read-back
// first: USDC's balance slot for the account, and the paymaster's `signers`
// mapping for a LOCAL key (the public test mnemonic's first address), which
// then signs the paymaster data in Pimlico's exact format with the rate and
// postOpGas of a real stub answer (fetched live when a bundler is configured,
// else the stub recorded on 2026-10-04). Cases: (1) approve + call, charged at
// most the approval; (2) an approval one unit below the charge: postOp's
// transferFrom fails, the operation is marked failed and no USDC moves;
// (3) the engine refuses final data above the displayed maximum, and data
// with a preFund, before anything is signed.
//
// LIVE (TOKEN_GAS_LIVE=1 CHAIN_ID=11155111; needs ZERODEV_PROJECT_ID or
// BUNDLER_URL and the git-ignored dev seed): the dev seed's index-2 Kernel
// account 0x1D723b78e1D0D84Fd0531e2686285fb1B6414106 pays one UserOperation
// (approve + a 0-value call to the owner EOA) in Sepolia USDC. If it holds
// less than TOKEN_GAS_MIN_USDC (default 0.5 USDC), the dev EOA first buys
// USDC for it with SWAP_ETH test ETH (default 0.001, refused above 0.005) on
// Uniswap v3's Sepolia SwapRouter02, the pool and amount read from Uniswap's
// Sepolia factory and QuoterV2 (addresses from docs.uniswap.org v3 Ethereum
// deployments, fetched 2026-10-04), simulated with eth_call first.

const SEPOLIA_USDC = PIMLICO_ERC20_PAYMASTER_V07.tokens['11155111'];
const PIMLICO = PIMLICO_ERC20_PAYMASTER_V07.address;
const SEPOLIA_DEV_ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const SEPOLIA_DEV_INDEX = 2n;
/** docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments (Sepolia column). */
const UNISWAP_SEPOLIA = {
  factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  quoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
};
/** WETH9 on Sepolia (Uniswap's deployments page "Wrapped Native Token Addresses"; also pinned in activity-decode.ts). */
const SEPOLIA_WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const SWAP_FEE_TIER = 500n;
const SWAP_ETH_CAP = 5_000_000_000_000_000n; // 0.005 test ETH, the brief's cap
/** The stub ZeroDev's Sepolia endpoint returned on 2026-10-04 (used when no bundler is configured). */
const RECORDED_STUB = {
  paymaster: PIMLICO,
  paymasterData:
    '0x03000000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000004a2e' +
    '00000000000000000000000000000000000000000000000000000000b2cdc40300000000000000000000000000000001d8baa1' +
    '07006c93a030d1455a2ef43261b384f21ccd91f19f0f19ce862d7bec7b7d9b95457145afc6f639c28fd0360f488937bfa41e6e' +
    'edcd3a46054fd95fcd0e3ef6b0bc0a615c4d975eef55c8a3517257904d5b1c',
  paymasterPostOpGasLimit: '0x10d7e',
};
/** The app's quote headroom on this path (token-gas.ts ERC7677_TOKEN_GAS_HEADROOM_PERCENT). */
const APPROVAL_HEADROOM_PERCENT = 25n;

function mappingSlot(key, slot) {
  const preimage = new Uint8Array(64);
  preimage.set(toBytes(key), 12);
  preimage.set(toBytes(word(slot)), 32);
  return toHex(keccak_256(preimage));
}

async function callWith(to, signature, args, overrides, block = 'latest') {
  return node('eth_call', [{ to, data: toHex(encodeFunctionCall(signature, args)) }, block, ...(overrides ? [overrides] : [])]);
}

/** Finds the storage slot of a mapping(address => uint/bool) by override read-back (slots 0..15). */
async function proveMappingSlot(contract, getter, key, value) {
  for (let slot = 0n; slot < 16n; slot++) {
    const overrides = { [contract]: { stateDiff: { [mappingSlot(key, slot)]: word(value) } } };
    const answer = await callWith(contract, getter, [{ kind: 'address', value: key }], overrides).catch(() => '0x');
    if (answer !== '0x' && BigInt(answer) === value) return slot;
  }
  return null;
}

async function bundlerFees(bundler) {
  // The app's rule (aa.ts quoteFeesOverFloor with AA_FEE_FLOOR_HEADROOM_PERCENT = 100):
  // the standard tier's priority fee doubled, keeping the base-fee allowance.
  const answer = await bundler('pimlico_getUserOperationGasPrice', []);
  const priority = BigInt(answer.standard.maxPriorityFeePerGas) * 2n;
  const nodeFees = await nodeClient.suggestFees();
  const maxFee = nodeFees.maxFeePerGas + (priority > nodeFees.maxPriorityFeePerGas ? priority - nodeFees.maxPriorityFeePerGas : 0n);
  const stdMax = BigInt(answer.standard.maxFeePerGas) * 2n;
  return { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee > stdMax ? maxFee : stdMax };
}

async function pimlicoSepolia() {
  const state = await readPimlicoPaymasterState(node, PIMLICO);
  const problems = pimlicoPaymasterProblems(state);
  log(`Pimlico ERC-20 paymaster ${PIMLICO}: code keccak ${state.runtimeCodeKeccak}, entryPoint ${state.entryPoint}, ` +
    `deposit ${state.deposit} wei, staked ${state.staked} (${state.stake} wei, ${state.unstakeDelaySec} s)`);
  check('Pimlico paymaster passes the engine checks (code hash, EntryPoint v0.7, deposit)', problems.length === 0, problems.join(' '));
  if (problems.length > 0) {
    process.exitCode = 1;
    return;
  }
  if (LIVE) return pimlicoLive(state);
  return pimlicoDryRun();
}

async function pimlicoDryRun() {
  const useDev = process.env.DRY_RUN_OWNER === 'dev';
  const owner = loadOwner(useDev ? readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim() : PUBLIC_TEST_MNEMONIC);
  const spec = createKernelAccountSpec({ node, index: useDev ? SEPOLIA_DEV_INDEX : 0n });
  const account = await spec.getAddress(owner);
  const deployed = (await node('eth_getCode', [account, 'latest'])) !== '0x';
  log(`DRY RUN on Ethereum Sepolia (${useDev ? 'dev seed, index 2' : 'public test mnemonic, index 0'}): owner ${owner.address}, Kernel account ${account}, deployed ${deployed}`);
  const beneficiary = '0x000000000000000000000000000000000000bEEF';
  // The local stand-in for Pimlico's signer: the public test mnemonic's first address.
  const localSigner = loadOwner(PUBLIC_TEST_MNEMONIC);

  // A real stub answer when a bundler is configured, else the recorded one.
  let stub = RECORDED_STUB;
  if (BUNDLER_URL) {
    const bundler = async (method, params) => bundlerRaw(method, params);
    if (BigInt(await bundler('eth_chainId', [])) !== CHAIN_ID) throw new Error('The bundler serves another chain');
    const probeTransport = createErc7677TokenPaymasterTransport({ upstream: bundler, chainId: CHAIN_ID, account, token: SEPOLIA_USDC });
    stub = await probeTransport('pm_getPaymasterStubData', [
      toRpcUserOperation({ sender: account, nonce: 0n, callData: new Uint8Array(0), callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: new Uint8Array(0) }),
      ENTRYPOINT_V07, '0x' + CHAIN_ID.toString(16), null,
    ]);
    log('Stub fetched live from the configured bundler (context {token: USDC}).');
  } else {
    log('No bundler configured: using the stub recorded on 2026-10-04.');
  }
  const stubData = parsePimlicoErc20PaymasterData(toBytes(stub.paymasterData));
  log(`Stub: token ${stubData.token}, exchangeRate ${stubData.exchangeRate} base units per ETH, postOpGas ${stubData.postOpGas}, ` +
    `constantFee ${stubData.constantFee}, preFund ${stubData.preFundPresent}, recipient ${stubData.recipientPresent}, treasury ${stubData.treasury}`);
  check('stub is ERC-20 mode for Sepolia USDC with no preFund and no recipient',
    stubData.token.toLowerCase() === SEPOLIA_USDC.toLowerCase() && !stubData.preFundPresent && !stubData.recipientPresent);

  // Prove both override slots by read-back.
  const usdcSlot = await proveMappingSlot(SEPOLIA_USDC, 'balanceOf(address)', account, 7_000_000n);
  check('USDC balance slot found by override read-back', usdcSlot !== null, `slot ${usdcSlot}`);
  const signerSlot = await proveMappingSlot(PIMLICO, 'signers(address)', localSigner.address, 1n);
  check('paymaster signers slot found by override read-back', signerSlot !== null, `slot ${signerSlot}`);
  if (usdcSlot === null || signerSlot === null) {
    process.exitCode = 1;
    return;
  }
  const usdcHeld = 5_000_000n;
  const overrides = {
    [SEPOLIA_USDC]: { stateDiff: { [mappingSlot(account, usdcSlot)]: word(usdcHeld) } },
    [PIMLICO]: { stateDiff: { [mappingSlot(localSigner.address, signerSlot)]: word(1n) } },
    [account]: { balance: '0x0' },
    [beneficiary]: { balance: '0xde0b6b3a7640000' },
  };

  const fees = await nodeClient.suggestFees();
  if (fees.maxPriorityFeePerGas < 100_000_000n) {
    fees.maxFeePerGas += 100_000_000n - fees.maxPriorityFeePerGas;
    fees.maxPriorityFeePerGas = 100_000_000n;
  }
  const nonce = BigInt(await callWith(ENTRYPOINT_V07, 'getNonce(address,uint192)', [{ kind: 'address', value: account }, { kind: 'uint256', value: 0n }]));
  const factoryArgs = deployed ? undefined : await spec.getFactoryArgs(owner);
  const gas = {
    callGasLimit: 200_000n,
    verificationGasLimit: deployed ? 250_000n : 600_000n,
    preVerificationGas: 120_000n,
    paymasterVerificationGasLimit: 80_000n,
    paymasterPostOpGasLimit: BigInt(stub.paymasterPostOpGasLimit),
  };
  // The paymaster data in Pimlico's format: the stub's terms, signed locally.
  const pmFields = { ...stubData, validUntil: 0n, validAfter: 0n, allowAllBundlers: true, signature: new Uint8Array(65) };
  const bound = erc7677MaxTokenCharge({ ...gas, maxFeePerGas: fees.maxFeePerGas }, pmFields);
  const displayed = (bound * (100n + APPROVAL_HEADROOM_PERCENT) + 99n) / 100n;
  log(`Worst-case bound ${fmtUsdc(bound)}; displayed and approved ${fmtUsdc(displayed)} (+${APPROVAL_HEADROOM_PERCENT}%)`);

  async function opWithApproval(approval) {
    const callData = spec.encodeCalls([
      erc7677TokenApproveCall(SEPOLIA_USDC, PIMLICO, approval),
      { to: owner.address, value: 0n, data: new Uint8Array(0) },
    ]);
    const base = {
      sender: account,
      nonce,
      ...(factoryArgs ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData } : {}),
      callData,
      ...gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      paymaster: PIMLICO,
      paymasterData: encodePimlicoErc20PaymasterData(pmFields),
      signature: spec.stubSignature(),
    };
    const pmHash = pimlicoErc20PaymasterHash(base, CHAIN_ID);
    const pmSig = withEthereumV(localSigner.sign(toEthSignedMessageHash(pmHash)));
    const op = { ...base, paymasterData: encodePimlicoErc20PaymasterData({ ...pmFields, signature: pmSig }) };
    const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
    return { ...op, signature: await spec.signUserOpHash(owner, hash), userOpHash: toHex(hash) };
  }
  const read = (to, signature, args) => ({ from: beneficiary, to, data: toHex(encodeFunctionCall(signature, args)) });
  const afterReads = [
    read(SEPOLIA_USDC, 'balanceOf(address)', [{ kind: 'address', value: account }]),
    read(SEPOLIA_USDC, 'allowance(address,address)', [{ kind: 'address', value: account }, { kind: 'address', value: PIMLICO }]),
    read(ENTRYPOINT_V07, 'balanceOf(address)', [{ kind: 'address', value: account }]),
  ];
  const depositBefore = BigInt(await callWith(ENTRYPOINT_V07, 'balanceOf(address)', [{ kind: 'address', value: account }]));

  // Case 1.
  const op1 = await opWithApproval(displayed);
  const [h1, bal1, allow1, dep1] = await simulate(op1, overrides, beneficiary, afterReads);
  check('case 1 handleOps succeeds', h1.status === '0x1', h1.error ? describeRevert(h1.error.data) : '');
  const ev1 = h1.logs.find((l) => l.topics[0] === USER_OPERATION_EVENT);
  check('case 1 UserOperationEvent success', !!ev1 && BigInt('0x' + ev1.data.slice(2 + 64, 2 + 128)) === 1n);
  check('case 1 UserOperationEvent names Pimlico’s paymaster', !!ev1 && ev1.topics[3].slice(26).toLowerCase() === PIMLICO.slice(2).toLowerCase());
  const sp1 = decodePimlicoSponsoredEvents(h1.logs).filter((e) => e.userOpHash === op1.userOpHash);
  check('case 1 UserOperationSponsored (ERC-20 mode) emitted once', sp1.length === 1 && sp1[0].mode === 1);
  const paid1 = sp1[0]?.tokenAmountPaid ?? -1n;
  check('case 1 USDC debit equals tokenAmountPaid', usdcHeld - BigInt(bal1.returnData) === paid1, fmtUsdc(paid1));
  check('case 1 charge within the engine bound and the approval', paid1 > 0n && paid1 <= bound && bound <= displayed, `${fmtUsdc(paid1)} <= ${fmtUsdc(bound)}`);
  check('case 1 allowance left = approval − charge', BigInt(allow1.returnData) === displayed - paid1, fmtUsdc(BigInt(allow1.returnData)));
  check('case 1 account EntryPoint deposit unchanged', BigInt(dep1.returnData) === depositBefore, `${depositBefore} wei`);
  check('case 1 no ETH leaves the account (it holds none)', !h1.logs.some((l) =>
    l.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' && l.topics[1]?.slice(26).toLowerCase() === account.slice(2).toLowerCase()));

  // Case 2: an approval one unit below the charge.
  const op2 = await opWithApproval(paid1 - 1n);
  const [h2, bal2] = await simulate(op2, overrides, beneficiary, afterReads.slice(0, 1));
  const ev2 = h2.logs?.find((l) => l.topics[0] === USER_OPERATION_EVENT);
  const success2 = ev2 ? BigInt('0x' + ev2.data.slice(2 + 64, 2 + 128)) : null;
  check('case 2 approval one unit below the charge: the operation fails and no USDC moves',
    (h2.status === '0x0' || success2 === 0n) && BigInt(bal2?.returnData ?? '0x0') === usdcHeld,
    h2.error ? describeRevert(h2.error.data) : `success=${success2}`);

  // Case 3: the engine refuses before signing.
  const finalAnswer = async (data, limit) => {
    const t = createErc7677TokenPaymasterTransport({
      upstream: async () => ({ paymaster: PIMLICO, paymasterData: toHex(encodePimlicoErc20PaymasterData(data)), paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit }),
      chainId: CHAIN_ID, account, token: SEPOLIA_USDC, maxTokenCharge: limit,
    });
    const rpc = toRpcUserOperation({ ...op1, signature: new Uint8Array(0) });
    return t('pm_getPaymasterData', [rpc, ENTRYPOINT_V07, '0x' + CHAIN_ID.toString(16), null]).then(() => null, (e) => e);
  };
  const signedFields = { ...pmFields, signature: new Uint8Array(65).fill(1) };
  const atLimit = await finalAnswer(signedFields, bound);
  const belowLimit = await finalAnswer(signedFields, bound - 1n);
  check('case 3 final data exactly at the displayed maximum is accepted; one unit lower refused (TokenGasChargeAboveLimitError)',
    atLimit === null && belowLimit instanceof TokenGasChargeAboveLimitError, belowLimit?.message ?? '');
  const preFund = await finalAnswer({ ...signedFields, preFundPresent: true, preFundInToken: 1n }, displayed);
  check('case 3 final data with a preFund is refused', preFund !== null && /preFund/.test(preFund.message), preFund?.message ?? '');

  log(failures === 0 ? 'SEPOLIA DRY RUN PASSED' : `SEPOLIA DRY RUN FAILED (${failures})`);
  if (failures) process.exitCode = 1;
}

/** Buys a little Sepolia USDC for `recipient` with the dev EOA's test ETH (simulated first). */
async function swapForUsdc(owner, recipient) {
  const amountIn = BigInt(process.env.SWAP_ETH_WEI ?? '1000000000000000');
  if (amountIn <= 0n || amountIn > SWAP_ETH_CAP) throw new Error(`SWAP_ETH_WEI must be in (0, ${SWAP_ETH_CAP}]`);
  const pool = await callWith(UNISWAP_SEPOLIA.factory, 'getPool(address,address,uint24)', [
    { kind: 'address', value: SEPOLIA_WETH }, { kind: 'address', value: SEPOLIA_USDC }, { kind: 'uint256', value: SWAP_FEE_TIER },
  ]);
  if (BigInt(pool) === 0n) throw new Error('No WETH/USDC 0.05% pool on Sepolia');
  const quote = await callWith(UNISWAP_SEPOLIA.quoterV2, 'quoteExactInputSingle((address,address,uint256,uint24,uint160))', [{
    kind: 'tuple',
    items: [
      { kind: 'address', value: SEPOLIA_WETH }, { kind: 'address', value: SEPOLIA_USDC },
      { kind: 'uint256', value: amountIn }, { kind: 'uint256', value: SWAP_FEE_TIER }, { kind: 'uint256', value: 0n },
    ],
  }]);
  const amountOut = BigInt('0x' + quote.slice(2, 66));
  const minOut = (amountOut * 97n) / 100n;
  log(`Swap quote (pool 0x${pool.slice(26)}): ${amountIn} wei -> ${fmtUsdc(amountOut)}; minimum ${fmtUsdc(minOut)}`);
  const data = encodeFunctionCall('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', [{
    kind: 'tuple',
    items: [
      { kind: 'address', value: SEPOLIA_WETH }, { kind: 'address', value: SEPOLIA_USDC }, { kind: 'uint256', value: SWAP_FEE_TIER },
      { kind: 'address', value: recipient }, { kind: 'uint256', value: amountIn }, { kind: 'uint256', value: minOut }, { kind: 'uint256', value: 0n },
    ],
  }]);
  const txCall = { from: owner.address, to: UNISWAP_SEPOLIA.swapRouter02, data: toHex(data), value: '0x' + amountIn.toString(16) };
  const simulated = await node('eth_call', [txCall, 'latest']);
  log(`Swap simulated with eth_call: ${fmtUsdc(BigInt(simulated))} out`);
  const gas = BigInt(await node('eth_estimateGas', [txCall]));
  const nodeFees = await nodeClient.suggestFees();
  const tx = signEip1559({
    chainId: CHAIN_ID,
    nonce: await nodeClient.getTransactionCount(owner.address),
    maxPriorityFeePerGas: nodeFees.maxPriorityFeePerGas,
    maxFeePerGas: nodeFees.maxFeePerGas,
    gasLimit: (gas * 130n) / 100n,
    to: UNISWAP_SEPOLIA.swapRouter02,
    value: amountIn,
    data,
  }, owner);
  const hash = await nodeClient.sendRawTransaction(tx.rawHex);
  log(`Swap transaction: ${hash}`);
  const receipt = await waitForTx(hash);
  check('swap status 1', receipt.status === '0x1', `block ${BigInt(receipt.blockNumber)}`);
  const usdcIn = receipt.logs.filter((l) => l.address.toLowerCase() === SEPOLIA_USDC.toLowerCase() && l.topics[0] === TRANSFER &&
    l.topics[2].slice(26).toLowerCase() === recipient.slice(2).toLowerCase());
  check('swap paid USDC to the smart account', usdcIn.length === 1 && BigInt(usdcIn[0].data) >= minOut, usdcIn[0] ? fmtUsdc(BigInt(usdcIn[0].data)) : 'none');
}

async function pimlicoLive(state) {
  if (!BUNDLER_URL) throw new Error('Set ZERODEV_PROJECT_ID (or BUNDLER_URL) for live mode.');
  const bundler = async (method, params) => bundlerRaw(method, params);
  if (BigInt(await bundler('eth_chainId', [])) !== CHAIN_ID) throw new Error('The bundler serves another chain');
  const owner = loadOwner(readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim());
  const spec = createKernelAccountSpec({ node, index: SEPOLIA_DEV_INDEX });
  const account = await spec.getAddress(owner);
  if (account.toLowerCase() !== SEPOLIA_DEV_ACCOUNT.toLowerCase()) throw new Error(`Unexpected account ${account}`);
  if ((await node('eth_getCode', [account, 'latest'])) === '0x') throw new Error('The dev index-2 Kernel account is not deployed on Sepolia');
  log(`LIVE on Ethereum Sepolia: owner ${owner.address}, Kernel account ${account}, bundler ${BUNDLER_URL}`);

  const minUsdc = BigInt(process.env.TOKEN_GAS_MIN_USDC ?? '500000');
  let { balance } = await readTokenBalanceAndAllowance(node, SEPOLIA_USDC, account, PIMLICO);
  log(`Account USDC: ${fmtUsdc(balance)}`);
  if (balance < minUsdc) {
    await swapForUsdc(owner, account);
    ({ balance } = await readTokenBalanceAndAllowance(node, SEPOLIA_USDC, account, PIMLICO));
    log(`Account USDC now ${fmtUsdc(balance)}`);
  }

  const fees = await bundlerFees(bundler);
  log(`Fees (standard tier × 2, the app's rule): maxFeePerGas ${fees.maxFeePerGas}, maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}`);
  const userCall = { to: owner.address, value: 0n, data: new Uint8Array(0) };
  const padding = { verification: 110, call: 130, preVerification: 105 };

  // Quote (what the app does before the device check): stub + estimate with
  // a placeholder approval of the whole balance, then the bound over the
  // padded estimate plus the headroom = the displayed maximum.
  const quotes = [];
  const transportFor = (maxTokenCharge) => createErc7677TokenPaymasterTransport({
    upstream: bundler, chainId: CHAIN_ID, account, token: SEPOLIA_USDC, maxTokenCharge, onQuote: (q) => quotes.push(q),
  });
  const client0 = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node, spec });
  const nonce = await client0.getNonce(owner);
  const placeholder = { sender: account, nonce, callData: spec.encodeCalls([erc7677TokenApproveCall(SEPOLIA_USDC, PIMLICO, balance), userCall]),
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, ...fees, signature: spec.stubSignature() };
  const stub = await transportFor(undefined)('pm_getPaymasterStubData', [toRpcUserOperation(placeholder), ENTRYPOINT_V07, '0x' + CHAIN_ID.toString(16), null]);
  const stubOp = { ...placeholder, paymaster: stub.paymaster, paymasterData: toBytes(stub.paymasterData), paymasterPostOpGasLimit: BigInt(stub.paymasterPostOpGasLimit),
    ...(stub.paymasterVerificationGasLimit ? { paymasterVerificationGasLimit: BigInt(stub.paymasterVerificationGasLimit) } : {}) };
  const est = await bundler('eth_estimateUserOperationGas', [toRpcUserOperation(stubOp), ENTRYPOINT_V07]);
  log(`Bundler estimate: ${JSON.stringify(est)}`);
  const pad = (v, pct) => (BigInt(v) * BigInt(pct)) / 100n;
  const stubData = parsePimlicoErc20PaymasterData(toBytes(stub.paymasterData));
  const bound = erc7677MaxTokenCharge({
    callGasLimit: pad(est.callGasLimit, padding.call),
    verificationGasLimit: pad(est.verificationGasLimit, padding.verification),
    preVerificationGas: pad(est.preVerificationGas, padding.preVerification),
    paymasterVerificationGasLimit: est.paymasterVerificationGasLimit ? pad(est.paymasterVerificationGasLimit, padding.verification) : 0n,
    // SmartAccountClient keeps the stub's postOp limit (it applies only the
    // estimate's paymasterVerificationGasLimit), so that is what is signed.
    paymasterPostOpGasLimit: BigInt(stub.paymasterPostOpGasLimit),
    maxFeePerGas: fees.maxFeePerGas,
  }, stubData);
  const displayed = (bound * (100n + APPROVAL_HEADROOM_PERCENT) + 99n) / 100n;
  log(`Stub rate ${stubData.exchangeRate} base units per ETH, postOpGas ${stubData.postOpGas}; bound ${fmtUsdc(bound)}; displayed and approved ${fmtUsdc(displayed)}`);
  if (balance < displayed) throw new Error(`The account holds ${fmtUsdc(balance)}, below the displayed maximum ${fmtUsdc(displayed)}`);

  // The real operation through SmartAccountClient's ERC-7677 seam.
  const client = new SmartAccountClient({
    chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node, spec,
    paymaster: { transport: transportFor(displayed) },
    gasPaddingPct: padding,
  });
  quotes.length = 0;
  const { userOpHash, userOp } = await client.sendCalls(owner, [erc7677TokenApproveCall(SEPOLIA_USDC, PIMLICO, displayed), userCall], fees);
  const final = quotes.find((q) => q.phase === 'final');
  log(`Final paymaster data: rate ${final.data.exchangeRate}, postOpGas ${final.data.postOpGas}, constantFee ${final.data.constantFee}, ` +
    `validUntil ${final.data.validUntil}, allowAllBundlers ${final.data.allowAllBundlers}; final bound ${fmtUsdc(final.maxTokenCharge)}`);
  log(`UserOperation accepted by the bundler: ${userOpHash}`);
  const opReceipt = await client.waitForReceipt(userOpHash, { timeoutMs: 180_000, pollMs: 4_000 });
  const txHash = opReceipt?.receipt?.transactionHash;
  log(`Bundle transaction: ${txHash}`);
  const receipt = await waitForTx(txHash);
  const block = BigInt(receipt.blockNumber);
  check('bundle transaction status 1', receipt.status === '0x1', `block ${block}`);
  const opEvent = receipt.logs.find((l) => l.topics[0] === USER_OPERATION_EVENT && l.topics[1] === userOpHash);
  check('UserOperationEvent success', !!opEvent && BigInt('0x' + opEvent.data.slice(2 + 64, 2 + 128)) === 1n);
  check('UserOperationEvent paymaster is Pimlico’s', !!opEvent && opEvent.topics[3].slice(26).toLowerCase() === PIMLICO.slice(2).toLowerCase());
  const actualGasCost = opEvent ? BigInt('0x' + opEvent.data.slice(2 + 128, 2 + 192)) : 0n;
  const sponsored = decodePimlicoSponsoredEvents(receipt.logs).filter((e) => e.userOpHash === userOpHash);
  check('UserOperationSponsored (ERC-20 mode) for this operation', sponsored.length === 1 && sponsored[0].mode === 1);
  const paid = sponsored[0]?.tokenAmountPaid ?? -1n;
  log(`  actualGasCost ${actualGasCost} wei; tokenAmountPaid ${fmtUsdc(paid)}; exchangeRate ${sponsored[0]?.exchangeRate}`);
  const at = (b) => '0x' + b.toString(16);
  const eth = async (b) => BigInt(await node('eth_getBalance', [account, at(b)]));
  const dep = async (who, b) => BigInt(await callWith(ENTRYPOINT_V07, 'balanceOf(address)', [{ kind: 'address', value: who }], undefined, at(b)));
  const tok = (b) => readTokenBalanceAndAllowance(node, SEPOLIA_USDC, account, PIMLICO, at(b));
  const [ethBefore, ethAfter, depBefore, depAfter, pmBefore, pmAfter, tokBefore, tokAfter] = await Promise.all([
    eth(block - 1n), eth(block), dep(account, block - 1n), dep(account, block), dep(PIMLICO, block - 1n), dep(PIMLICO, block), tok(block - 1n), tok(block),
  ]);
  check('account ETH balance unchanged', ethBefore === ethAfter, `${ethBefore} wei`);
  check('account EntryPoint deposit unchanged', depBefore === depAfter, `${depBefore} wei`);
  check('USDC debit equals tokenAmountPaid', tokBefore.balance - tokAfter.balance === paid, `${fmtUsdc(tokBefore.balance)} -> ${fmtUsdc(tokAfter.balance)}`);
  check('charge within the final bound and the displayed maximum', paid > 0n && paid <= final.maxTokenCharge && final.maxTokenCharge <= displayed,
    `${fmtUsdc(paid)} <= ${fmtUsdc(final.maxTokenCharge)} <= ${fmtUsdc(displayed)}`);
  check('allowance afterwards = approval − charge', tokAfter.allowance === displayed - paid, `before ${tokBefore.allowance}, after ${tokAfter.allowance}`);
  check('paymaster EntryPoint deposit paid the gas', pmBefore - pmAfter === actualGasCost, `${pmBefore} -> ${pmAfter}`);
  const transfers = receipt.logs.filter((l) => l.address.toLowerCase() === SEPOLIA_USDC.toLowerCase() && l.topics[0] === TRANSFER);
  for (const l of transfers) log(`  USDC Transfer 0x${l.topics[1].slice(26)} -> 0x${l.topics[2].slice(26)}: ${fmtUsdc(BigInt(l.data))}`);
  check('the signed operation carried the paymaster the transport accepted', userOp.paymaster.toLowerCase() === PIMLICO.toLowerCase());
  log(failures === 0 ? 'SEPOLIA LIVE RUN PASSED' : `SEPOLIA LIVE RUN FAILED (${failures})`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(mask(`token-gas smoke failed: ${error.stack ?? error.message}`));
  process.exit(1);
});

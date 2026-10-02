/**
 * EIP-7702 smoke test on Sepolia (phase 8, item 1): a plain EOA delegates
 * to the Kernel v3.3 implementation, sends one ERC-4337 UserOperation (an
 * ERC-7579 batch) AS ITSELF through EntryPoint v0.7, and then revokes the
 * delegation so the key is left as a plain EOA again.
 *
 * Paths (see packages/chains-evm/src/eip7702.ts and kernel-account.ts for
 * the sources):
 *   bundler (default)  the first UserOperation carries the signed tuple as
 *                      `eip7702Auth`; the bundler puts it in the
 *                      authorization list of its type-0x04 bundle
 *                      transaction. If the bundler refuses it, the script
 *                      falls back to the self path and says so.
 *   self               a self-sponsored type-0x04 transaction from the EOA
 *                      (tuple nonce = tx nonce + 1) installs the delegation,
 *                      then the UserOperation goes out without a tuple.
 * Revocation is always a self-sponsored type-0x04 transaction whose tuple
 * names the zero address.
 *
 * Every UserOperation is simulated first through EntryPoint v0.7
 * handleOps with eth_call (and eth_simulateV1 for the UserOperationEvent
 * success flag), with a state override that gives the EOA the delegation
 * indicator when the delegation is not on-chain yet. The script aborts
 * before contacting the bundler if that simulation reverts.
 *
 * Environment variables:
 *   EIP7702_SMOKE_DRY_RUN=1  no keys, no broadcast: PUBLIC test mnemonic,
 *                     fake bundler (unless BUNDLER_URL is set, in which case
 *                     only its read-only eth_estimateUserOperationGas is
 *                     called), handleOps simulation with balance + code
 *                     overrides, and the self-sponsored delegation and
 *                     revocation transactions built, signed and decoded with
 *                     ethers but never sent.
 *   BUNDLER_URL       live: Sepolia bundler RPC (eth_sendUserOperation).
 *   PROBE_BUNDLER_URL optional second bundler, asked ONLY
 *                     eth_estimateUserOperationGas with the tuple attached,
 *                     to record whether it accepts eip7702Auth.
 *   NODE_URL          optional; defaults to the public Sepolia RPC.
 *   EIP7702_INDEX     address index of the test EOA, m/44'/60'/0'/0/{index};
 *                     default 7 (never the main dev EOA at index 0).
 *   EIP7702_FUND_ETH  live funding target for the test EOA; default 0.0015,
 *                     hard maximum 0.002.
 *   EIP7702_MODE      'bundler' (default) or 'self'.
 *   EIP7702_NO_SWEEP=1  keep the leftover test ETH on the test EOA instead of
 *                     returning it to the dev EOA after revocation.
 *
 * Run from the repository root after `npm run build`:
 *   Dry run (anyone, read-only):
 *     EIP7702_SMOKE_DRY_RUN=1 node scripts/testnet/eip7702-smoke.mjs
 *   Live (dev wallet; URLs embed keys and are never printed):
 *     set -a; . .dev-wallet/env; set +a
 *     BUNDLER_URL="https://rpc.zerodev.app/api/v3/$ZERODEV_PROJECT_ID/chain/11155111" \
 *       PROBE_BUNDLER_URL="$ALCHEMY_SEPOLIA" \
 *       node scripts/testnet/eip7702-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Transaction, verifyAuthorization, Signature } from 'ethers';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  KERNEL_V3_3_7702_DELEGATE,
  NodeClient,
  SmartAccountClient,
  createKernel7702AccountSpec,
  encodeFunctionCall,
  getUserOpHash,
  hashEip191Message,
  httpTransport,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  readDelegationStatus,
  revokeDelegationAuthorization,
  selfSponsoredAuthorizationNonce,
  setCodeIntrinsicGas,
  signEip1559,
  signEip7702Authorization,
  signEip7702Transaction,
  toBytes,
  toHex,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const CHAIN_ID = 11155111n;
const DRY_RUN = process.env.EIP7702_SMOKE_DRY_RUN === '1';
const BUNDLER_URL = process.env.BUNDLER_URL;
const PROBE_BUNDLER_URL = process.env.PROBE_BUNDLER_URL;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const INDEX = Number(process.env.EIP7702_INDEX ?? '7');
const MODE = process.env.EIP7702_MODE ?? 'bundler';
const NO_SWEEP = process.env.EIP7702_NO_SWEEP === '1';
const MAX_FUND_WEI = 2n * 10n ** 15n; // 0.002 ETH hard cap
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

if (!DRY_RUN && !BUNDLER_URL) {
  console.error('Set BUNDLER_URL (Sepolia bundler RPC), or EIP7702_SMOKE_DRY_RUN=1 for a read-only dry run.');
  process.exit(1);
}
if (!Number.isInteger(INDEX) || INDEX < 1) {
  console.error('EIP7702_INDEX must be a positive integer (index 0 is the main dev EOA).');
  process.exit(1);
}
if (MODE !== 'bundler' && MODE !== 'self') {
  console.error("EIP7702_MODE must be 'bundler' or 'self'.");
  process.exit(1);
}

/** Removes every configured URL and key from text before it is printed. */
const SECRETS = [BUNDLER_URL, PROBE_BUNDLER_URL, process.env.NODE_URL, process.env.ZERODEV_PROJECT_ID, process.env.ALCHEMY_KEY]
  .filter((s) => typeof s === 'string' && s.length >= 8);
function redact(text) {
  let out = String(text);
  for (const s of SECRETS) out = out.split(s).join('<redacted>');
  return out;
}
const hostOf = (url) => (url ? new URL(url).host : '(none)');
const log = (...parts) => console.log(redact(parts.join(' ')));

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);

const HANDLE_OPS_SIG =
  'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';
const USER_OPERATION_EVENT_TOPIC = toHex(
  keccak_256(utf8ToBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')),
);
const ERC1271_MAGIC = '0x1626ba7e';
const indicatorFor = (delegate) => ('0xef0100' + delegate.slice(2)).toLowerCase();

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

/** UserOperationEvent for `userOpHash`: { sender, success } or null. */
function findUserOpEvent(logs, userOpHash) {
  for (const entry of logs ?? []) {
    if (entry.topics?.[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC) continue;
    if (entry.topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    return {
      sender: '0x' + entry.topics[2].slice(26),
      success: BigInt('0x' + entry.data.slice(2 + 64, 2 + 128)) === 1n,
    };
  }
  return null;
}

/** RPC (hex) UserOperation -> engine UserOperation (the tuple is not part of handleOps). */
function fromRpc(r) {
  return {
    sender: r.sender,
    nonce: BigInt(r.nonce),
    ...(r.factory ? { factory: r.factory, factoryData: toBytes(r.factoryData ?? '0x') } : {}),
    callData: toBytes(r.callData),
    callGasLimit: BigInt(r.callGasLimit),
    verificationGasLimit: BigInt(r.verificationGasLimit),
    preVerificationGas: BigInt(r.preVerificationGas),
    maxFeePerGas: BigInt(r.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas),
    signature: toBytes(r.signature),
  };
}

/**
 * Read-only handleOps([op]) simulation. `overrides` may give the sender the
 * delegation indicator (the tuple is not processed by eth_call). Returns
 * { executed: true|false|null } (null when eth_simulateV1 is unavailable).
 */
async function simulate(op, from, overrides) {
  const data = toHex(encodeHandleOps(op, from));
  const call = { from, to: ENTRYPOINT_V07, data, gas: '0x989680' };
  await node('eth_call', overrides ? [call, 'latest', overrides] : [call, 'latest']);
  const userOpHash = toHex(getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID));
  try {
    const sim = await node('eth_simulateV1', [
      { blockStateCalls: [{ ...(overrides ? { stateOverrides: overrides } : {}), calls: [call] }] },
      'latest',
    ]);
    const event = findUserOpEvent(sim[0].calls[0].logs, userOpHash);
    return { executed: event ? event.success : null, event };
  } catch {
    return { executed: null, event: null };
  }
}

async function waitForTx(hash) {
  for (let i = 0; i < 60; i++) {
    const receipt = await node('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Timed out waiting for transaction ${hash}`);
}

function parseEth(text) {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}
const fmtEth = (wei) => `${Number(wei) / 1e18} ETH`;

/** Bundler gas price: pimlico_getUserOperationGasPrice when served, else node fees + 0.15 gwei floor. */
async function userOpFees(bundler) {
  try {
    const res = await bundler('pimlico_getUserOperationGasPrice', []);
    log(`pimlico_getUserOperationGasPrice answered with keys: ${Object.keys(res ?? {}).join(', ')}`);
    const tier = res?.standard;
    if (tier?.maxFeePerGas && tier?.maxPriorityFeePerGas) {
      return { maxFeePerGas: BigInt(tier.maxFeePerGas), maxPriorityFeePerGas: BigInt(tier.maxPriorityFeePerGas), source: 'pimlico_getUserOperationGasPrice.standard' };
    }
  } catch (error) {
    log(`pimlico_getUserOperationGasPrice not usable: ${error.message}`);
  }
  const fees = await nodeClient.suggestFees();
  const floor = 150_000_000n;
  if (fees.maxPriorityFeePerGas < floor) {
    fees.maxFeePerGas += floor - fees.maxPriorityFeePerGas;
    fees.maxPriorityFeePerGas = floor;
  }
  return { ...fees, source: 'node suggestFees + 0.15 gwei priority floor' };
}

/** Self-sponsored type-0x04 transaction: tuple nonce = tx nonce + 1. */
async function buildSelfSponsoredSetCode(owner, delegate, fees, txNonce) {
  const nonce = txNonce ?? (await nodeClient.getTransactionCount(owner.address));
  const auth = signEip7702Authorization(
    { chainId: CHAIN_ID, address: delegate, nonce: selfSponsoredAuthorizationNonce(nonce) },
    owner,
  );
  // To self, empty data: after the tuple is processed the call runs the new
  // code (Kernel's receive() for a delegation, nothing for a revocation).
  return signEip7702Transaction(
    {
      chainId: CHAIN_ID,
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit: setCodeIntrinsicGas(1) + 40_000n,
      to: owner.address,
      value: 0n,
      authorizationList: [auth],
    },
    owner,
  );
}

/** Decodes a raw type-0x04 transaction with ethers and checks sender, tuple and authority. */
function checkWithEthers(rawHex, owner, delegate, label) {
  const tx = Transaction.from(rawHex);
  const auth = tx.authorizationList?.[0];
  const authority = auth ? verifyAuthorization(auth, auth.signature) : null;
  const ok =
    tx.type === 4 &&
    tx.from === owner.address &&
    tx.authorizationList.length === 1 &&
    auth.address.toLowerCase() === delegate.toLowerCase() &&
    auth.nonce === BigInt(tx.nonce) + 1n &&
    authority === owner.address;
  log(`${label}: ethers decodes type ${tx.type}, from ${tx.from}, tuple -> ${auth?.address} nonce ${auth?.nonce} (tx nonce ${tx.nonce}), authority ${authority}: ${ok ? 'OK' : 'MISMATCH'}`);
  if (!ok) throw new Error(`${label} failed the ethers cross-check`);
}

async function main() {
  const mnemonic = DRY_RUN
    ? PUBLIC_TEST_MNEMONIC
    : readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  const keyring = HdKeyring.fromMnemonic(mnemonic, registry);
  const funder = keyring.getAccount('eip155:1', 0, 0);
  const eoa = keyring.getAccount('eip155:1', 0, INDEX);
  log(`${DRY_RUN ? 'DRY RUN (public test mnemonic). ' : ''}Test EOA ${eoa.path}: ${eoa.address}`);
  if (!DRY_RUN) log(`Funding EOA (index 0): ${funder.address}`);
  log(`Node: ${hostOf(NODE_URL)}; bundler: ${hostOf(BUNDLER_URL)}; probe bundler: ${hostOf(PROBE_BUNDLER_URL)}; mode: ${MODE}`);

  const chainId = await nodeClient.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`Not Sepolia: chain id ${chainId}`);
  const deployment = await verifyKernelDeployment(node);
  log(`Kernel v3.3 verified on-chain: ${JSON.stringify(deployment)}`);
  const delegate = KERNEL_V3_3_7702_DELEGATE;
  const indicator = indicatorFor(delegate);

  const initial = await readDelegationStatus(node, eoa.address);
  log(`Initial delegation status of the test EOA: ${JSON.stringify(initial)}`);
  if (initial.kind === 'contract') throw new Error('Test address holds contract code');
  if (initial.kind === 'delegated' && initial.delegate.toLowerCase() !== delegate.toLowerCase() && !DRY_RUN) {
    throw new Error(`Test EOA is delegated to ${initial.delegate}; refusing to touch it`);
  }

  const realBundler = BUNDLER_URL ? httpTransport(BUNDLER_URL) : null;
  if (realBundler) {
    const supported = await realBundler('eth_supportedEntryPoints', []);
    log(`Bundler ${hostOf(BUNDLER_URL)} entry points: ${JSON.stringify(supported)}`);
    if (!supported.map((a) => a.toLowerCase()).includes(ENTRYPOINT_V07.toLowerCase())) {
      throw new Error('Bundler does not support EntryPoint v0.7');
    }
  }

  // Preflight wrapper: every eth_sendUserOperation is simulated through the
  // EntryPoint first. In the dry run (or estimate-only mode) it is captured.
  let captured = null;
  let estimateOnly = DRY_RUN;
  const makeBundler = (transport, { label }) => async (method, params) => {
    if (method === 'eth_estimateUserOperationGas' && params[0].eip7702Auth) {
      log(`${label}: eth_estimateUserOperationGas with eip7702Auth ${JSON.stringify(params[0].eip7702Auth)}`);
    }
    if (method === 'eth_sendUserOperation') {
      captured = params[0];
      if (estimateOnly) return '0x' + '00'.repeat(32);
      const overrides = params[0].eip7702Auth ? { [params[0].sender]: { code: indicator } } : undefined;
      const sim = await simulate(fromRpc(params[0]), funder.address, overrides);
      log(`Preflight handleOps simulation passed (execution success = ${sim.executed})`);
      if (sim.executed === false) throw new Error('Preflight: simulated execution failed');
    }
    if (!transport) {
      if (method === 'eth_estimateUserOperationGas') {
        return { callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0x186a0' };
      }
      throw new Error(`fake bundler: unexpected ${method}`);
    }
    return transport(method, params);
  };

  const spec = createKernel7702AccountSpec({ node, chainId: CHAIN_ID });
  const clientFor = (bundler) =>
    new SmartAccountClient({
      chainId: CHAIN_ID,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
      gasPaddingPct: { verification: 110, call: 150, preVerification: 105 },
    });

  // One UserOperation: an ERC-7579 BATCH — 1 wei to the funding EOA and a
  // 0-value self-call — so batching from the delegated EOA is proven.
  const calls = [
    { to: funder.address, value: 1n, data: new Uint8Array(0) },
    { to: eoa.address, value: 0n, data: new Uint8Array(0) },
  ];

  if (DRY_RUN) {
    const fees = realBundler ? await userOpFees(realBundler) : { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, source: 'fixed (dry run)' };
    log(`Fees: ${fees.maxFeePerGas} / ${fees.maxPriorityFeePerGas} wei (${fees.source})`);
    const dryInitial = initial.kind === 'delegated' && initial.delegate.toLowerCase() !== delegate.toLowerCase()
      ? createKernel7702AccountSpec({ node, chainId: CHAIN_ID, allowRedelegation: true })
      : spec;
    const dryClient = new SmartAccountClient({
      chainId: CHAIN_ID,
      entryPoint: ENTRYPOINT_V07,
      bundler: makeBundler(realBundler, { label: 'dry run' }),
      node,
      spec: dryInitial,
      gasPaddingPct: { verification: 110, call: 150, preVerification: 105 },
    });
    if (initial.kind === 'delegated') log('(The public test EOA is already delegated on Sepolia; the dry run still builds a fresh tuple.)');
    const { userOp } = await dryClient.sendCalls(eoa, calls, fees);
    const rpc = captured;
    log(`Signed op: sender ${userOp.sender}, nonce ${userOp.nonce}, factory ${userOp.factory ?? '(none)'}, eip7702Auth ${rpc.eip7702Auth ? JSON.stringify(rpc.eip7702Auth) : '(none)'}`);
    if (rpc.eip7702Auth) {
      const a = rpc.eip7702Auth;
      const authority = verifyAuthorization(
        { chainId: BigInt(a.chainId), address: a.address, nonce: BigInt(a.nonce) },
        Signature.from({ r: a.r, s: a.s, yParity: Number(a.yParity) }),
      );
      log(`ethers recovers the tuple's authority: ${authority} (${authority === eoa.address ? 'OK' : 'MISMATCH'})`);
      if (authority !== eoa.address) throw new Error('Tuple authority mismatch');
    }
    const overrides = {
      [eoa.address]: { balance: '0xde0b6b3a7640000', code: indicator },
      [funder.address]: { balance: '0xde0b6b3a7640000' },
    };
    let result;
    try {
      result = await simulate(userOp, funder.address, overrides);
      log(`handleOps simulation with the EOA code overridden to the delegation indicator: validation passed; execution success = ${result.executed}`);
    } catch (error) {
      log(`Simulation with the 23-byte indicator override failed (${error.message}); retrying with the delegate's full runtime code as the override.`);
      const runtime = await node('eth_getCode', [delegate, 'latest']);
      overrides[eoa.address].code = runtime;
      result = await simulate(userOp, funder.address, overrides);
      log(`handleOps simulation with full-code override: validation passed; execution success = ${result.executed}`);
    }
    if (result.executed === false) throw new Error('Simulated execution reported success=false');
    if (result.event) log(`Simulated UserOperationEvent sender = ${result.event.sender}`);
    const flipped = { ...userOp, signature: userOp.signature.slice() };
    flipped.signature[10] ^= 0xff;
    try {
      await simulate(flipped, funder.address, overrides);
      throw new Error('A flipped signature byte was accepted');
    } catch (error) {
      if (/was accepted/.test(error.message)) throw error;
      log('Negative check: a flipped signature byte makes handleOps revert (as expected).');
    }

    // Self-sponsored delegation and revocation transactions: signed and
    // decoded, never sent.
    const fees1559 = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const pending = await nodeClient.getTransactionCount(eoa.address);
    const setCode = await buildSelfSponsoredSetCode(eoa, delegate, fees1559, pending);
    checkWithEthers(setCode.rawHex, eoa, delegate, 'Self-sponsored delegation tx');
    const revoke = await buildSelfSponsoredSetCode(eoa, '0x0000000000000000000000000000000000000000', fees1559, pending);
    checkWithEthers(revoke.rawHex, eoa, '0x0000000000000000000000000000000000000000', 'Revocation tx');
    log('\nDRY RUN PASSED: the engine-built 7702 UserOperation validates and executes against the real');
    log('EntryPoint v0.7 and Kernel v3.3 on Sepolia (delegation simulated by state override); the');
    log('delegation and revocation transactions decode correctly with ethers. Nothing was broadcast.');
    return;
  }

  // ---------------------------------------------------------------- LIVE --
  const fees = await userOpFees(realBundler);
  log(`UserOperation fees: maxFee ${fees.maxFeePerGas} / priority ${fees.maxPriorityFeePerGas} wei (${fees.source})`);
  const txFees = await nodeClient.suggestFees();

  // 1. Fund the test EOA from index 0, capped at 0.002 ETH.
  const target = parseEth(process.env.EIP7702_FUND_ETH ?? '0.0015');
  if (target > MAX_FUND_WEI) throw new Error('EIP7702_FUND_ETH above the 0.002 ETH cap');
  const balance = await nodeClient.getBalance(eoa.address);
  if (balance < target) {
    const fund = signEip1559(
      {
        chainId: CHAIN_ID,
        nonce: await nodeClient.getTransactionCount(funder.address),
        maxPriorityFeePerGas: txFees.maxPriorityFeePerGas,
        maxFeePerGas: txFees.maxFeePerGas,
        gasLimit: 21_000n,
        to: eoa.address,
        value: target - balance,
      },
      funder,
    );
    const hash = await nodeClient.sendRawTransaction(fund.rawHex);
    log(`Funding the test EOA with ${fmtEth(target - balance)}: ${hash}`);
    const receipt = await waitForTx(hash);
    if (receipt.status !== '0x1') throw new Error('Funding transaction failed');
  }
  log(`Test EOA balance: ${fmtEth(await nodeClient.getBalance(eoa.address))}`);

  // 2. Optional estimate-only probe of a second bundler with the tuple attached.
  if (PROBE_BUNDLER_URL && initial.kind !== 'delegated') {
    const probe = httpTransport(PROBE_BUNDLER_URL);
    try {
      const eps = await probe('eth_supportedEntryPoints', []);
      log(`Probe bundler ${hostOf(PROBE_BUNDLER_URL)} entry points: ${JSON.stringify(eps)}`);
      estimateOnly = true;
      await clientFor(makeBundler(probe, { label: 'probe' })).sendCalls(eoa, calls, fees);
      log(`Probe bundler ${hostOf(PROBE_BUNDLER_URL)} ACCEPTED eth_estimateUserOperationGas with eip7702Auth (nothing was sent to it).`);
    } catch (error) {
      log(`Probe bundler ${hostOf(PROBE_BUNDLER_URL)} REJECTED the estimate with eip7702Auth: ${error.message}`);
    } finally {
      estimateOnly = false;
      captured = null;
    }
  }

  // 3. Delegation + the UserOperation.
  let delegationPath = null;
  let selfDelegationTx = null;
  const status = await readDelegationStatus(node, eoa.address);
  if (status.kind === 'delegated') {
    delegationPath = 'already delegated (earlier run)';
  } else if (MODE === 'self') {
    delegationPath = 'self-sponsored type-0x04 transaction (EIP7702_MODE=self)';
  }
  if (MODE === 'self' && status.kind !== 'delegated') {
    selfDelegationTx = await sendSelfSponsoredDelegation(eoa, delegate, txFees);
  }

  const client = clientFor(makeBundler(realBundler, { label: 'bundler' }));
  let sent;
  try {
    sent = await client.sendCalls(eoa, calls, fees);
    if (!delegationPath) delegationPath = 'eip7702Auth on the UserOperation (bundler type-0x04 bundle)';
  } catch (error) {
    if (delegationPath || /^Preflight/.test(error.message)) throw error;
    log(`Bundler REJECTED the UserOperation carrying eip7702Auth: ${error.message}`);
    log('Falling back to a self-sponsored type-0x04 delegation, then the op without a tuple.');
    delegationPath = 'self-sponsored type-0x04 transaction (bundler refused eip7702Auth)';
    selfDelegationTx = await sendSelfSponsoredDelegation(eoa, delegate, txFees);
    sent = await client.sendCalls(eoa, calls, fees);
  }
  const { userOpHash, userOp } = sent;
  const localHash = toHex(getUserOpHash(userOp, ENTRYPOINT_V07, CHAIN_ID));
  log(`UserOperation accepted by ${hostOf(BUNDLER_URL)}: ${userOpHash} (carried eip7702Auth: ${userOp.eip7702Auth ? 'yes' : 'no'})`);
  log(`Locally computed v0.7 userOpHash ${localHash === userOpHash.toLowerCase() ? 'MATCHES' : 'DIFFERS FROM'} the bundler's.`);
  const opReceipt = await client.waitForReceipt(userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
  const bundleTxHash = opReceipt?.receipt?.transactionHash ?? opReceipt?.transactionHash;
  log(`UserOperation receipt: success=${JSON.stringify(opReceipt?.success)} bundle tx ${bundleTxHash}`);

  // 4. On-chain confirmation.
  const bundleTx = await node('eth_getTransactionByHash', [bundleTxHash]);
  log(`Bundle tx: type ${bundleTx.type}, to ${bundleTx.to}, authorizationList ${JSON.stringify(bundleTx.authorizationList ?? null)}`);
  const bundleReceipt = await waitForTx(bundleTxHash);
  const event = findUserOpEvent(bundleReceipt.logs, userOpHash);
  log(`Bundle receipt status ${bundleReceipt.status}, block ${BigInt(bundleReceipt.blockNumber)}; UserOperationEvent sender ${event?.sender} success ${event?.success}`);
  if (!event || event.sender.toLowerCase() !== eoa.address.toLowerCase() || event.success !== true) {
    throw new Error('UserOperationEvent does not show a successful op from the EOA');
  }
  const code = await node('eth_getCode', [eoa.address, 'latest']);
  log(`eth_getCode(EOA) = ${code} (${code.toLowerCase() === indicator ? 'equals 0xef0100 || Kernel v3.3 implementation' : 'UNEXPECTED'})`);
  if (code.toLowerCase() !== indicator) throw new Error('Delegation indicator not found');

  // 5. Read-only checks against the delegated EOA.
  const call = (data, from) => node('eth_call', [{ ...(from ? { from } : {}), to: eoa.address, data: toHex(data) }, 'latest']);
  const ep = await call(encodeFunctionCall('entrypoint()', []));
  log(`Delegated EOA entrypoint() = 0x${ep.slice(26)}`);
  const message = hashEip191Message(utf8ToBytes('shiba-wallet eip7702 smoke'));
  const sig = spec.signErc1271(eoa, message, { chainId: CHAIN_ID, account: eoa.address });
  const magic = await call(encodeFunctionCall('isValidSignature(bytes32,bytes)', [
    { kind: 'fixedBytes', value: message },
    { kind: 'bytes', value: sig },
  ]));
  log(`isValidSignature(0x00 || EOA signature over the Kernel wrapper) = ${magic.slice(0, 10)} (${magic.startsWith(ERC1271_MAGIC) ? 'ERC-1271 magic' : 'NOT magic'})`);
  try {
    await call(
      encodeFunctionCall('initialize(bytes21,address,bytes,bytes,bytes[])', [
        { kind: 'fixedBytes', value: toBytes('0x01' + KERNEL_V3_3.ecdsaValidator.slice(2)) },
        { kind: 'address', value: '0x0000000000000000000000000000000000000000' },
        { kind: 'bytes', value: toBytes(funder.address) },
        { kind: 'bytes', value: new Uint8Array(0) },
        { kind: 'array', items: [] },
      ]),
      funder.address,
    );
    log('WARNING: initialize() by a third party did NOT revert on the delegated EOA');
  } catch (error) {
    log(`initialize() by a third party reverts on the delegated EOA (as the source predicts): ${error.message.slice(0, 120)}`);
  }

  // 6. Revoke: self-sponsored type-0x04 with a zero-address tuple.
  const revokeNonce = await nodeClient.getTransactionCount(eoa.address);
  const revokeFees = await nodeClient.suggestFees();
  const revokeAuth = signEip7702Authorization(
    revokeDelegationAuthorization(CHAIN_ID, selfSponsoredAuthorizationNonce(revokeNonce)),
    eoa,
  );
  const revokeTx = signEip7702Transaction(
    {
      chainId: CHAIN_ID,
      nonce: revokeNonce,
      maxPriorityFeePerGas: revokeFees.maxPriorityFeePerGas,
      maxFeePerGas: revokeFees.maxFeePerGas,
      gasLimit: setCodeIntrinsicGas(1) + 40_000n,
      to: eoa.address,
      value: 0n,
      authorizationList: [revokeAuth],
    },
    eoa,
  );
  const revokeHash = await nodeClient.sendRawTransaction(revokeTx.rawHex);
  log(`Revocation tx (tuple -> 0x0, nonce ${revokeAuth.nonce} = tx nonce ${revokeNonce} + 1): ${revokeHash}`);
  const revokeReceipt = await waitForTx(revokeHash);
  const after = await node('eth_getCode', [eoa.address, 'latest']);
  log(`Revocation status ${revokeReceipt.status}, block ${BigInt(revokeReceipt.blockNumber)}, gas used ${BigInt(revokeReceipt.gasUsed)}; eth_getCode(EOA) now ${after}`);
  if (revokeReceipt.status !== '0x1' || (after !== '0x' && after !== '0x0')) throw new Error('Revocation did not clear the code');

  // 7. Return leftover test ETH to the funding EOA.
  if (!NO_SWEEP) {
    const left = await nodeClient.getBalance(eoa.address);
    const sweepFees = await nodeClient.suggestFees();
    const cost = 21_000n * sweepFees.maxFeePerGas;
    if (left > cost) {
      const sweep = signEip1559(
        {
          chainId: CHAIN_ID,
          nonce: await nodeClient.getTransactionCount(eoa.address),
          maxPriorityFeePerGas: sweepFees.maxPriorityFeePerGas,
          maxFeePerGas: sweepFees.maxFeePerGas,
          gasLimit: 21_000n,
          to: funder.address,
          value: left - cost,
        },
        eoa,
      );
      const sweepHash = await nodeClient.sendRawTransaction(sweep.rawHex);
      log(`Returned ${fmtEth(left - cost)} to the funding EOA: ${sweepHash}`);
      await waitForTx(sweepHash);
    }
  }

  log('\nEIP-7702 SMOKE PASSED');
  log(`  EOA ${eoa.address} (m/44'/60'/0'/0/${INDEX}) delegated to Kernel v3.3 ${delegate}`);
  log(`  delegation path: ${delegationPath}${selfDelegationTx ? ` (${selfDelegationTx})` : ''}`);
  log(`  UserOperation ${userOpHash} via ${hostOf(BUNDLER_URL)}, bundle tx ${bundleTxHash} (type ${bundleTx.type})`);
  log(`  revoked by ${revokeHash}; code is empty again`);
}

async function sendSelfSponsoredDelegation(eoa, delegate, fees) {
  const tx = await buildSelfSponsoredSetCode(eoa, delegate, fees);
  const hash = await nodeClient.sendRawTransaction(tx.rawHex);
  log(`Self-sponsored delegation tx: ${hash}`);
  const receipt = await waitForTx(hash);
  if (receipt.status !== '0x1') throw new Error('Delegation transaction failed');
  const status = await readDelegationStatus(node, eoa.address);
  log(`Delegation status after the type-0x04 tx: ${JSON.stringify(status)}`);
  if (status.kind !== 'delegated') throw new Error('Delegation not visible after the set-code transaction');
  return hash;
}

main().catch((e) => {
  console.error(redact(`EIP-7702 smoke failed: ${e.message}`));
  process.exit(1);
});

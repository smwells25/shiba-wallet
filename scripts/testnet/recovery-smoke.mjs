/**
 * Social-recovery smoke test on Sepolia (phase 8, item 4): ZeroDev's
 * WeightedECDSAValidator as the guardian validator plus RecoveryAction on a
 * Kernel v3.3 account, driven only by engine code
 * (packages/chains-evm/src/kernel-recovery.ts).
 *
 * LIVE flow, on the dev seed's ALREADY-DEPLOYED Kernel account (index 2):
 *   1. generate two fresh guardian keys (only their addresses are printed;
 *      they live in memory for this run only);
 *   2. the ROOT owner (the dev EOA) installs them — weights 1 and 1,
 *      threshold 2, no delay — with one UserOperation (installModule for the
 *      validator with doRecovery as its only selector, installModule for the
 *      RecoveryAction fallback);
 *   3. read-only ERC-1271 probes: both guardians together, one guardian
 *      alone, and one guardian's signature repeated twice, each through the
 *      account's isValidSignature;
 *   4. the guardians rotate the root owner to a FRESH key (address index 9 of
 *      the dev seed, m/44'/60'/0'/0/9, derived with the engine): one approval
 *      signature plus the submitting guardian's userOpHash signature, sent
 *      through the bundler on the guardian nonce lane;
 *   5. prove the OLD owner can no longer sign: its operation fails a
 *      read-only handleOps simulation (AA24) and the bundler refuses it at
 *      submission (estimation alone is not a signal: the ECDSA validator
 *      returns SIG_VALIDATION_FAILED instead of reverting, which bundlers
 *      tolerate while estimating);
 *   6. the NEW owner signs one UserOperation that rotates the owner back to
 *      the dev EOA and removes the guardians — proving the new key works and
 *      leaving the account as found;
 *   7. read-only proofs that the original owner signs again and that the
 *      guardians can no longer act.
 * Every operation sent is first simulated through EntryPoint v0.7 handleOps
 * with eth_call. If anything fails mid-way the script restores the original
 * owner (with whichever key currently owns the account) and removes the
 * guardians before exiting.
 *
 * DRY RUN (RECOVERY_SMOKE_DRY_RUN=1): no keys from .dev-wallet, no bundler,
 * nothing broadcast. Uses the PUBLIC BIP-39 test mnemonic's Kernel accounts
 * (undeployed on Sepolia) in three read-only eth_simulateV1 requests:
 *   A. no delay: deploy + install, ERC-1271 probes, guardian recovery, old
 *      owner rejected, new owner rotates back and removes guardians, original
 *      owner works, guardians rejected afterwards;
 *   B. one-hour delay: immediate path refused, approveWithSig, execution
 *      refused before the delay and accepted after it (block time override);
 *   C. one-hour delay with the owner's veto: execution refused even after
 *      the delay.
 *
 * Environment:
 *   ZERODEV_PROJECT_ID  live only; bundler URL
 *                       https://rpc.zerodev.app/api/v3/{id}/chain/11155111
 *                       (docs.zerodev.app/meta-infra/rpcs). Never printed.
 *   BUNDLER_URL         optional override of the bundler URL. Never printed.
 *   NODE_URL            optional; defaults to the public Sepolia RPC.
 *   KERNEL_INDEX        optional; default 2 live (the dev seed's account
 *                       0x1D723b78e1D0D84Fd0531e2686285fb1B6414106), 0 dry.
 *   NEW_OWNER_INDEX     optional; default 9 (address index of the new owner).
 *   RECOVERY_FUND_ETH   optional, live only: top up the account from the dev
 *                       EOA by this much first (estimated-gas transfer).
 *   SELF_BUNDLE_ON_REJECT=1  optional, live only: if the bundler refuses the
 *                       GUARDIAN op for a policy reason (not a signature or
 *                       preflight failure), submit it via handleOps from the
 *                       dev EOA (ERC-4337 permits self-bundling).
 *
 * Run from the repository root after `npm run build`:
 *   Live:    set -a; . .dev-wallet/env; set +a; node scripts/testnet/recovery-smoke.mjs
 *   Dry run: RECOVERY_SMOKE_DRY_RUN=1 node scripts/testnet/recovery-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_RECOVERY_MODULES,
  KERNEL_V3_3,
  NodeClient,
  SmartAccountClient,
  assembleGuardianApprovals,
  buildGuardianRecoveryRequest,
  createKernelAccountSpec,
  createSessionKeyAccount,
  encodeApproveWithSig,
  encodeFunctionCall,
  encodeGuardianSignature,
  encodeKernelExecute,
  encodeVetoCall,
  generateSessionPrivateKey,
  getUserOpHash,
  guardianInstallCalls,
  guardianNonceKey,
  guardianSignatureExposure,
  guardianUninstallCalls,
  httpTransport,
  kernelErc1271Digest,
  kernelGuardianRecoverySpec,
  kernelRecoveredAccountSpec,
  kernelValidatorId,
  ownerRotationCalls,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  prepareGuardianInstall,
  prepareGuardianRecovery,
  readGuardianState,
  readKernelOwner,
  recoveryCall,
  signEip1559,
  signGuardianApproval,
  signGuardianUserOpHash,
  toBytes,
  toHex,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const DRY_RUN = process.env.RECOVERY_SMOKE_DRY_RUN === '1';
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const INDEX = BigInt(process.env.KERNEL_INDEX ?? (DRY_RUN ? '0' : '2'));
const NEW_OWNER_INDEX = Number(process.env.NEW_OWNER_INDEX ?? '9');
const EXPECTED_ACCOUNT = INDEX === 2n && !DRY_RUN ? '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106' : '';
const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID
    ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/11155111`
    : undefined);
const SELF_BUNDLE = process.env.SELF_BUNDLE_ON_REJECT === '1';
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN_ID = 11155111n;
const ERC1271_MAGIC = '0x1626ba7e';

if (!DRY_RUN && !BUNDLER_URL) {
  console.error('Set ZERODEV_PROJECT_ID (or BUNDLER_URL), or RECOVERY_SMOKE_DRY_RUN=1 for a read-only dry run.');
  process.exit(1);
}
if (!Number.isInteger(NEW_OWNER_INDEX) || NEW_OWNER_INDEX < 1) {
  console.error('NEW_OWNER_INDEX must be a positive integer (index 0 is the current owner).');
  process.exit(1);
}

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);

/** Never print a bundler URL: it embeds the project id / API key. */
function maskSecrets(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) {
    out = out.split(secret).join('<masked>');
  }
  return out;
}

const HANDLE_OPS_SIG =
  'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';
const topic = (sig) => toHex(keccak_256(utf8ToBytes(sig)));
const errorSelector = (sig) => topic(sig).slice(0, 10);
const USER_OPERATION_EVENT = topic('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
const KNOWN_ERRORS = Object.fromEntries(
  [
    'FailedOp(uint256,string)',
    'FailedOpWithRevert(uint256,string,bytes)',
    'Error(string)',
    'InvalidValidator()',
    'InvalidNonce()',
    'InvalidSelector()',
    'InvalidCaller()',
    'InvalidValidationType()',
  ].map((s) => [errorSelector(s), s]),
);

function decodeAbiString(hexBody, wordOffset) {
  const word = (i) => hexBody.slice(i * 64, i * 64 + 64);
  const strOffset = Number(BigInt('0x' + word(wordOffset))) / 32;
  const strLen = Number(BigInt('0x' + word(strOffset)));
  return Buffer.from(hexBody.slice((strOffset + 1) * 64, (strOffset + 1) * 64 + strLen * 2), 'hex').toString();
}

/** Best-effort decoding of an EntryPoint / Solidity revert. */
function describeRevert(data) {
  if (typeof data !== 'string' || data.length < 10) return `revert data ${data}`;
  const sel = data.slice(0, 10).toLowerCase();
  const name = KNOWN_ERRORS[sel];
  if (!name) return `revert ${sel} (unknown selector)`;
  const body = data.slice(10);
  if (name === 'Error(string)') return `Error("${decodeAbiString(body, 0)}")`;
  if (name.startsWith('FailedOp')) {
    const reason = decodeAbiString(body, 1);
    let inner = '';
    if (name.startsWith('FailedOpWithRevert')) {
      const bOffset = Number(BigInt('0x' + body.slice(2 * 64, 3 * 64))) / 32;
      const bLen = Number(BigInt('0x' + body.slice(bOffset * 64, bOffset * 64 + 64)));
      const innerData = '0x' + body.slice((bOffset + 1) * 64, (bOffset + 1) * 64 + bLen * 2);
      inner = innerData === '0x' ? ' -> inner revert without data' : ` -> inner ${describeRevert(innerData)}`;
    }
    return `${name.split('(')[0]}("${reason}")${inner}`;
  }
  return name;
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

function userOpEventSuccess(logs, userOpHash) {
  for (const log of logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() !== USER_OPERATION_EVENT) continue;
    if (log.topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    return BigInt('0x' + log.data.slice(2 + 64, 2 + 128)) === 1n;
  }
  return null;
}

function revertDataOf(error) {
  const match = /(0x[0-9a-fA-F]{8,})/.exec(String(error?.message ?? error));
  return match ? match[1] : null;
}

/** JSON-RPC call that keeps the error's data field (httpTransport drops it). */
async function rawRpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) {
    const error = new Error(`RPC error ${body.error.code}: ${body.error.message}`);
    error.data = body.error.data;
    throw error;
  }
  return body.result;
}

/** Read-only handleOps([op]) through eth_call; returns { ok, reason }. */
async function simulateHandleOps(op, from) {
  const call = { from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x989680' };
  try {
    await rawRpc(NODE_URL, 'eth_call', [call, 'latest']);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeRevert(error.data ?? revertDataOf(error)) };
  }
}

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

function keyring(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry);
}

function freshGuardians() {
  // Sorted descending: the first approves, the last submits (the SDK's order).
  return [createSessionKeyAccount(generateSessionPrivateKey()), createSessionKeyAccount(generateSessionPrivateKey())].sort(
    (a, b) => (BigInt(a.address) > BigInt(b.address) ? -1 : 1),
  );
}

function guardianSet(guardians, delaySeconds) {
  return { guardians: guardians.map((g) => ({ address: g.address, weight: 1 })), threshold: 2, delaySeconds };
}

const isValidSignatureData = (hash, signature) =>
  toHex(
    encodeFunctionCall('isValidSignature(bytes32,bytes)', [
      { kind: 'fixedBytes', value: hash },
      { kind: 'bytes', value: signature },
    ]),
  );

/** ERC-1271 probe signatures over a fixed message hash, wrapped as Kernel does. */
function erc1271Probes(account, owner, guardians) {
  const hash = keccak_256(utf8ToBytes('shiba-wallet recovery smoke: ERC-1271 probe'));
  const digest = kernelErc1271Digest(hash, { chainId: CHAIN_ID, account });
  const envelope = (sigs) => new Uint8Array([...kernelValidatorId(KERNEL_RECOVERY_MODULES.weightedEcdsaValidator), ...sigs.flatMap((s) => [...s])]);
  const sig = (g) => signGuardianApproval(g, digest); // raw 65-byte signature over the wrapped digest
  const [hi, lo] = guardians;
  return {
    hash,
    probes: [
      { label: 'both guardians (descending)', signature: envelope([sig(hi), sig(lo)]), expectValid: true },
      { label: 'one guardian alone', signature: envelope([sig(lo)]), expectValid: false },
      { label: "one guardian's signature repeated twice", signature: envelope([sig(lo), sig(lo)]), expectValid: true },
      {
        label: 'root owner (validator envelope)',
        signature: new Uint8Array([...kernelValidatorId(KERNEL_V3_3.ecdsaValidator), ...signGuardianApproval(owner, digest)]),
        expectValid: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Dry run: eth_simulateV1
// ---------------------------------------------------------------------------

const GAS = {
  callGasLimit: 600_000n,
  verificationGasLimit: 1_500_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

function signRootOp(op, owner, spec) {
  return { ...op, signature: spec.signUserOpHash(owner, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) };
}

function guardianOp(account, request, approvals, submitter, gas = GAS) {
  const op = { sender: account, nonce: BigInt(request.nonce), callData: toBytes(request.callData), ...gas, signature: new Uint8Array(0) };
  return {
    ...op,
    signature: encodeGuardianSignature(approvals, signGuardianUserOpHash(submitter, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID))),
  };
}

async function simulate(blocks, from) {
  const result = await node('eth_simulateV1', [{ blockStateCalls: blocks }, 'latest']);
  return result;
}

function checkOpResult(label, call, op, expectAccepted, failures) {
  const hash = toHex(getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID));
  const executed = call.status === '0x1' ? userOpEventSuccess(call.logs, hash) : null;
  const accepted = call.status === '0x1' && executed === true;
  const detail = call.status === '0x1' ? `UserOperationEvent success=${executed}` : describeRevert(call.error?.data ?? call.returnData);
  const ok = accepted === expectAccepted;
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${accepted ? 'accepted' : 'rejected'} (${detail})`);
}

function checkCall(label, call, predicate, describe, failures) {
  const ok = predicate(call);
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${describe(call)}`);
}

const ownerOfCall = (account) => ({
  to: KERNEL_V3_3.ecdsaValidator,
  data: toHex(encodeFunctionCall('ecdsaValidatorStorage(address)', [{ kind: 'address', value: account }])),
});
const ownerFrom = (call) => (call.status === '0x1' ? '0x' + call.returnData.slice(26) : `revert ${call.returnData}`);

async function dryRun() {
  const keys = keyring(PUBLIC_TEST_MNEMONIC);
  const owner = keys.getAccount('eip155:1', 0, 0);
  const newOwner = keys.getAccount('eip155:1', 0, NEW_OWNER_INDEX);
  const failures = [];
  const latest = await node('eth_getBlockByNumber', ['latest', false]);
  const t0 = Number(BigInt(latest.timestamp));
  console.log(`DRY RUN (public test mnemonic). Owner ${owner.address}; new owner (index ${NEW_OWNER_INDEX}) ${newOwner.address}`);

  // ---------------- A: no delay ----------------
  {
    const spec = createKernelAccountSpec({ node, index: INDEX });
    const account = await spec.getAddress(owner);
    if ((await node('eth_getCode', [account, 'latest'])) !== '0x') throw new Error(`${account} is deployed; the dry run needs an undeployed account`);
    const guardians = freshGuardians();
    const set = guardianSet(guardians, 0);
    const exposure = guardianSignatureExposure(set);
    console.log(`\n[A] No delay. Kernel account ${account}; guardians ${guardians.map((g) => g.address).join(', ')} (1 + 1, threshold 2)`);
    console.log(`  engine exposure model: recovery needs ${exposure.recoveryMinimumGuardians}, ERC-1271 needs ${exposure.signatureMinimumGuardians}`);
    const factory = await spec.getFactoryArgs(owner);
    const deploy = signRootOp(
      { sender: account, nonce: 0n, ...factory, callData: encodeKernelExecute(guardianInstallCalls(account, set, { owner: owner.address })), ...GAS },
      owner,
      spec,
    );
    const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account, newOwner: newOwner.address, nonce: guardianNonceKey() << 64n, guardians: set.guardians });
    const [hi, lo] = guardians;
    const { approvals } = assembleGuardianApprovals(request, set, [signGuardianApproval(hi, toBytes(request.approvalDigest))], lo.address);
    const recover = guardianOp(account, request, approvals, lo);
    const oldOwnerOp = signRootOp({ sender: account, nonce: 1n, callData: encodeKernelExecute([{ to: account, value: 0n, data: new Uint8Array(0) }]), ...GAS }, owner, spec);
    const restore = signRootOp(
      {
        sender: account,
        nonce: 1n,
        callData: encodeKernelExecute([...ownerRotationCalls(owner.address, { account }), ...guardianUninstallCalls(account)]),
        ...GAS,
      },
      newOwner,
      spec,
    );
    const originalAgain = signRootOp({ sender: account, nonce: 2n, callData: encodeKernelExecute([{ to: account, value: 0n, data: new Uint8Array(0) }]), ...GAS }, owner, spec);
    const request2 = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account, newOwner: newOwner.address, nonce: (guardianNonceKey() << 64n) | 1n });
    const recoverAfter = guardianOp(account, request2, [signGuardianApproval(hi, toBytes(request2.approvalDigest))], lo);
    const probes = erc1271Probes(account, owner, guardians);
    const from = owner.address;
    const handle = (op) => ({ from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' });
    const probeCall = (p) => ({ from, to: account, data: isValidSignatureData(probes.hash, p.signature) });
    const blocks = [
      { blockOverrides: { time: '0x' + (t0 + 12).toString(16) }, stateOverrides: { [account]: { balance: '0xde0b6b3a7640000' }, [from]: { balance: '0xde0b6b3a7640000' } }, calls: [handle(deploy)] },
      { blockOverrides: { time: '0x' + (t0 + 24).toString(16) }, calls: probes.probes.map(probeCall) },
      { blockOverrides: { time: '0x' + (t0 + 36).toString(16) }, calls: [handle(recover), ownerOfCall(account)] },
      { blockOverrides: { time: '0x' + (t0 + 48).toString(16) }, calls: [handle(oldOwnerOp)] },
      { blockOverrides: { time: '0x' + (t0 + 60).toString(16) }, calls: [handle(restore), ownerOfCall(account)] },
      { blockOverrides: { time: '0x' + (t0 + 72).toString(16) }, calls: [handle(originalAgain), handle(recoverAfter), probeCall(probes.probes[0])] },
    ];
    const r = await simulate(blocks);
    checkOpResult('deploy + install guardians (root owner)', r[0].calls[0], deploy, true, failures);
    probes.probes.forEach((p, i) => {
      const call = r[1].calls[i];
      const valid = call.status === '0x1' && call.returnData.slice(0, 10).toLowerCase() === ERC1271_MAGIC;
      checkCall(`ERC-1271 ${p.label}`, call, () => valid === p.expectValid, () => (valid ? 'VALID (0x1626ba7e)' : `invalid (${call.status === '0x1' ? call.returnData.slice(0, 10) : describeRevert(call.error?.data ?? call.returnData)})`), failures);
    });
    checkOpResult('guardian recovery to the new owner', r[2].calls[0], recover, true, failures);
    checkCall('owner after recovery', r[2].calls[1], (c) => ownerFrom(c).toLowerCase() === newOwner.address.toLowerCase(), ownerFrom, failures);
    checkOpResult('old owner signs after recovery', r[3].calls[0], oldOwnerOp, false, failures);
    checkOpResult('new owner rotates back + removes guardians', r[4].calls[0], restore, true, failures);
    checkCall('owner after rotate-back', r[4].calls[1], (c) => ownerFrom(c).toLowerCase() === owner.address.toLowerCase(), ownerFrom, failures);
    checkOpResult('original owner signs again', r[5].calls[0], originalAgain, true, failures);
    checkOpResult('guardians try again after removal', r[5].calls[1], recoverAfter, false, failures);
    checkCall('guardian ERC-1271 after removal', r[5].calls[2], (c) => !(c.status === '0x1' && c.returnData.slice(0, 10).toLowerCase() === ERC1271_MAGIC), (c) => (c.status === '0x1' ? `returned ${c.returnData.slice(0, 10)}` : describeRevert(c.error?.data ?? c.returnData)), failures);
  }

  // ---------------- B and C: one-hour delay, with and without veto ----------------
  for (const veto of [false, true]) {
    const index = INDEX + (veto ? 2n : 1n);
    const spec = createKernelAccountSpec({ node, index });
    const account = await spec.getAddress(owner);
    if ((await node('eth_getCode', [account, 'latest'])) !== '0x') throw new Error(`${account} is deployed; the dry run needs an undeployed account`);
    const guardians = freshGuardians();
    const set = guardianSet(guardians, 3600);
    const [hi, lo] = guardians;
    console.log(`\n[${veto ? 'C' : 'B'}] One-hour delay${veto ? ' with the owner vetoing' : ''}. Kernel account ${account}`);
    const factory = await spec.getFactoryArgs(owner);
    const deploy = signRootOp(
      { sender: account, nonce: 0n, ...factory, callData: encodeKernelExecute(guardianInstallCalls(account, set, { owner: owner.address })), ...GAS },
      owner,
      spec,
    );
    const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account, newOwner: newOwner.address, nonce: guardianNonceKey() << 64n, guardians: set.guardians });
    const digest = toBytes(request.approvalDigest);
    const immediate = guardianOp(account, request, [signGuardianApproval(hi, digest)], lo);
    const approveTx = encodeApproveWithSig(request, [signGuardianApproval(hi, digest), signGuardianApproval(lo, digest)]);
    const delayed = guardianOp(account, request, [], lo);
    const vetoOp = signRootOp({ sender: account, nonce: 1n, callData: encodeKernelExecute([encodeVetoCall(request.callDataAndNonceHash)]), ...GAS }, owner, spec);
    const from = owner.address;
    const relayer = '0x000000000000000000000000000000000000bEEF';
    const handle = (op) => ({ from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' });
    const proposalCall = {
      to: KERNEL_RECOVERY_MODULES.weightedEcdsaValidator,
      data: toHex(encodeFunctionCall('proposalStatus(bytes32,address)', [{ kind: 'fixedBytes', value: toBytes(request.callDataAndNonceHash) }, { kind: 'address', value: account }])),
    };
    const approveTime = t0 + 36;
    const blocks = [
      { blockOverrides: { time: '0x' + (t0 + 12).toString(16) }, stateOverrides: { [account]: { balance: '0xde0b6b3a7640000' }, [from]: { balance: '0xde0b6b3a7640000' }, [relayer]: { balance: '0xde0b6b3a7640000' } }, calls: [handle(deploy)] },
      { blockOverrides: { time: '0x' + (t0 + 24).toString(16) }, calls: [handle(immediate)] },
      { blockOverrides: { time: '0x' + approveTime.toString(16) }, calls: [{ from: relayer, to: approveTx.to, data: toHex(approveTx.data) }, proposalCall, ...(veto ? [handle(vetoOp), proposalCall] : [])] },
      { blockOverrides: { time: '0x' + (approveTime + 60).toString(16) }, calls: [handle(delayed)] },
      { blockOverrides: { time: '0x' + (approveTime + 3601).toString(16) }, calls: [handle(delayed), ownerOfCall(account)] },
    ];
    const r = await simulate(blocks);
    checkOpResult('deploy + install guardians with a 3600 s delay', r[0].calls[0], deploy, true, failures);
    checkOpResult('immediate guardian op (no on-chain approval)', r[1].calls[0], immediate, false, failures);
    checkCall('approveWithSig from an unrelated relayer', r[2].calls[0], (c) => c.status === '0x1', (c) => `status ${c.status}`, failures);
    const statusOf = (c) => (c.status === '0x1' ? `status ${BigInt('0x' + c.returnData.slice(2, 66))}, validAfter ${BigInt('0x' + c.returnData.slice(66, 130))}` : 'revert');
    checkCall('proposal after approval (1 = Approved, validAfter = now + 3600)', r[2].calls[1], (c) => c.status === '0x1' && BigInt('0x' + c.returnData.slice(2, 66)) === 1n && BigInt('0x' + c.returnData.slice(66, 130)) === BigInt(approveTime + 3600), statusOf, failures);
    if (veto) {
      checkOpResult('owner vetoes (root op calling veto)', r[2].calls[2], vetoOp, true, failures);
      checkCall('proposal after veto (2 = Rejected)', r[2].calls[3], (c) => c.status === '0x1' && BigInt('0x' + c.returnData.slice(2, 66)) === 2n, statusOf, failures);
    }
    checkOpResult('guardian op before the delay has passed', r[3].calls[0], delayed, false, failures);
    checkOpResult(`guardian op after the delay${veto ? ' (vetoed)' : ''}`, r[4].calls[0], delayed, !veto, failures);
    checkCall('owner at the end', r[4].calls[1], (c) => ownerFrom(c).toLowerCase() === (veto ? owner.address : newOwner.address).toLowerCase(), ownerFrom, failures);
  }

  if (failures.length) throw new Error(`Dry run expectations not met: ${failures.join('; ')}`);
  console.log('\nDRY RUN PASSED against the real EntryPoint v0.7, Kernel v3.3, WeightedECDSAValidator and RecoveryAction');
  console.log('on Sepolia (simulated blocks; nothing was broadcast).');
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

async function waitForTx(hash) {
  for (let i = 0; i < 90; i++) {
    const receipt = await node('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

async function liveRun() {
  const keys = keyring(readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim());
  const owner = keys.getAccount('eip155:1', 0, 0);
  const newOwner = keys.getAccount('eip155:1', 0, NEW_OWNER_INDEX);
  const chainId = await nodeClient.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`Not Sepolia: chain id ${chainId}`);
  await verifyKernelDeployment(node);
  for (const [label, address] of Object.entries(KERNEL_RECOVERY_MODULES)) {
    const code = await node('eth_getCode', [address, 'latest']);
    if (!code || code === '0x') throw new Error(`${label} ${address} has no code`);
  }
  const rootSpec = createKernelAccountSpec({ node, index: INDEX });
  const account = await rootSpec.getAddress(owner);
  console.log(`Owner EOA ${owner.address}; Kernel account (index ${INDEX}) ${account}`);
  console.log(`New owner (m/44'/60'/0'/0/${NEW_OWNER_INDEX}) ${newOwner.address}`);
  if (EXPECTED_ACCOUNT && account.toLowerCase() !== EXPECTED_ACCOUNT.toLowerCase()) throw new Error(`Account ${account} is not the expected ${EXPECTED_ACCOUNT}`);
  const startOwner = await readKernelOwner(node, account);
  if (startOwner.owner.toLowerCase() !== owner.address.toLowerCase()) throw new Error(`Account is owned by ${startOwner.owner}, not the dev EOA; refusing`);

  if (process.env.RECOVERY_FUND_ETH) {
    const [whole, frac = ''] = process.env.RECOVERY_FUND_ETH.split('.');
    const value = BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
    const gas = BigInt(await node('eth_estimateGas', [{ from: owner.address, to: account, value: '0x' + value.toString(16) }]));
    const f = await nodeClient.suggestFees();
    const tx = signEip1559({ chainId, nonce: await nodeClient.getTransactionCount(owner.address), ...f, gasLimit: (gas * 120n) / 100n, to: account, value }, owner);
    const hash = await nodeClient.sendRawTransaction(tx.rawHex);
    const receipt = await waitForTx(hash);
    console.log(`Funded the account with ${process.env.RECOVERY_FUND_ETH} ETH: ${hash} (status ${receipt.status})`);
  }
  console.log(`Account balance ${await nodeClient.getBalance(account)} wei; dev EOA ${await nodeClient.getBalance(owner.address)} wei`);

  const bundlerTransport = httpTransport(BUNDLER_URL);
  const bundlerCall = async (method, params) => {
    try {
      return await bundlerTransport(method, params);
    } catch (error) {
      throw new Error(maskSecrets(error.message));
    }
  };
  const entryPoints = await bundlerCall('eth_supportedEntryPoints', []);
  if (!entryPoints.map((a) => a.toLowerCase()).includes(ENTRYPOINT_V07.toLowerCase())) throw new Error('Bundler does not support EntryPoint v0.7');

  const fees = await nodeClient.suggestFees();
  try {
    const standard = (await bundlerCall('pimlico_getUserOperationGasPrice', []))?.standard;
    if (standard) {
      const max = (a, b) => (a > b ? a : b);
      fees.maxFeePerGas = max(fees.maxFeePerGas, BigInt(standard.maxFeePerGas));
      fees.maxPriorityFeePerGas = max(fees.maxPriorityFeePerGas, BigInt(standard.maxPriorityFeePerGas));
    }
  } catch {
    // Not served by this bundler: keep the node suggestion.
  }
  console.log(`Fees: maxFeePerGas ${fees.maxFeePerGas}, maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}`);

  let lastSignedOp = null;
  const submitting = async (method, params) => {
    if (method === 'eth_sendUserOperation') {
      lastSignedOp = fromRpc(params[0]);
      const sim = await simulateHandleOps(lastSignedOp, owner.address);
      if (!sim.ok) throw new Error(`Preflight handleOps simulation failed: ${sim.reason}`);
      console.log('  preflight handleOps simulation passed');
    }
    return bundlerCall(method, params);
  };
  const padding = { verification: 120, call: 130, preVerification: 105 };
  const client = (spec, bundler, routedNode = node) =>
    new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node: routedNode, spec, gasPaddingPct: padding });

  async function send(label, c, signer, calls) {
    console.log(`\n${label}`);
    const { userOpHash } = await c.sendCalls(signer, calls, fees);
    console.log(`  accepted by bundler: userOpHash ${userOpHash}`);
    const receipt = await c.waitForReceipt(userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
    const success = receipt?.success === true || receipt?.success === '0x1';
    const tx = receipt?.receipt?.transactionHash ?? '?';
    console.log(`  receipt: success=${success} bundle tx ${tx}`);
    if (!success) throw new Error(`UserOperation ${userOpHash} did not succeed`);
    return { userOpHash, tx };
  }

  const guardians = freshGuardians();
  const [hi, lo] = guardians;
  const set = guardianSet(guardians, 0);
  console.log(`Fresh guardians (addresses only): ${hi.address} (approves), ${lo.address} (submits); weights 1 + 1, threshold 2, no delay`);
  const results = { account, originalOwner: owner.address, newOwner: newOwner.address, guardians: guardians.map((g) => g.address) };

  let stage = 'clean'; // clean | guardians | recovered
  try {
    // 1. Install guardians (root owner).
    const install = await prepareGuardianInstall(node, { account, set });
    const installed = await send('[1] Root owner installs the guardians', client(rootSpec, submitting), owner, install.calls);
    stage = 'guardians';
    results.install = installed;
    const state = await readGuardianState(node, account);
    console.log(`  on-chain: active=${state.active} guardians=${state.set?.guardians.map((g) => `${g.address}:${g.weight}`).join(',')} threshold=${state.set?.threshold} delay=${state.set?.delaySeconds}`);
    if (!state.active) throw new Error('Guardian configuration not active after install');

    // 2. ERC-1271 probes against live state (read-only).
    console.log('\n[2] ERC-1271 probes through the account (read-only eth_call)');
    const probes = erc1271Probes(account, owner, guardians);
    results.erc1271 = [];
    for (const p of probes.probes) {
      let verdict;
      try {
        const out = await rawRpc(NODE_URL, 'eth_call', [{ to: account, data: isValidSignatureData(probes.hash, p.signature) }, 'latest']);
        verdict = out.slice(0, 10).toLowerCase() === ERC1271_MAGIC ? 'VALID' : `invalid (${out.slice(0, 10)})`;
      } catch (error) {
        verdict = `reverted (${describeRevert(error.data ?? revertDataOf(error))})`;
      }
      console.log(`  ${p.label}: ${verdict}`);
      results.erc1271.push({ probe: p.label, result: verdict });
    }

    // 3. Guardian-signed recovery to the new owner.
    const { request, set: onChainSet } = await prepareGuardianRecovery(node, { chainId: CHAIN_ID, account, newOwner: newOwner.address });
    console.log(`\n[3] Guardians rotate the owner to ${newOwner.address}`);
    console.log(`  request: nonce ${request.nonce} (guardian lane), proposal ${request.callDataAndNonceHash}, approval digest ${request.approvalDigest}`);
    const { approvals, weight } = assembleGuardianApprovals(request, onChainSet, [signGuardianApproval(hi, toBytes(request.approvalDigest))], lo.address);
    console.log(`  approvals assembled: weight ${weight} of threshold ${onChainSet.threshold}`);
    const recoverySpec = kernelGuardianRecoverySpec({ request, approvals, submitter: lo.address });
    const recoveryClient = client(recoverySpec, submitting, recoverySpec.routeNode(node));
    try {
      results.recovery = await send('  sending the guardian operation', recoveryClient, lo, [recoveryCall(request)]);
    } catch (error) {
      if (!SELF_BUNDLE || !lastSignedOp || /^Preflight|did not succeed/.test(error.message)) throw error;
      console.log(`  bundler refused the guardian op (${maskSecrets(error.message)}); self-bundling via handleOps`);
      results.recovery = { selfBundled: await selfBundle(lastSignedOp, owner, fees) };
    }
    stage = 'recovered';
    const afterRecovery = await readKernelOwner(node, account);
    console.log(`  on-chain owner now ${afterRecovery.owner}`);
    if (afterRecovery.owner.toLowerCase() !== newOwner.address.toLowerCase()) throw new Error('Owner did not change to the new owner');

    // 4. The old owner can no longer sign. A wrong signature makes the ECDSA
    // validator RETURN SIG_VALIDATION_FAILED rather than revert, and bundlers
    // tolerate that during gas estimation (estimation runs on stub
    // signatures), so the rejection is observed at SUBMISSION, where the
    // bundler validates the real signature. The op is simulated first and
    // must fail with AA24; it can never be included.
    console.log('\n[4] Old owner tries a root operation (submitted; the bundler must refuse it)');
    let rejection;
    let simulatedReason;
    const expectRejected = async (method, params) => {
      if (method === 'eth_sendUserOperation') {
        const sim = await simulateHandleOps(fromRpc(params[0]), owner.address);
        if (sim.ok) throw new Error('NEGATIVE TEST: handleOps simulation accepted the OLD owner');
        simulatedReason = sim.reason;
      }
      return bundlerCall(method, params);
    };
    try {
      await client(rootSpec, expectRejected).sendCalls(owner, [{ to: account, value: 0n, data: new Uint8Array(0) }], fees);
      throw new Error('NEGATIVE TEST: the bundler accepted an operation signed by the old owner');
    } catch (error) {
      if (/NEGATIVE TEST/.test(error.message)) throw error;
      rejection = maskSecrets(error.message);
    }
    console.log(`  EntryPoint.handleOps simulation: ${simulatedReason}`);
    console.log(`  bundler refused it at submission: ${rejection}`);
    if (!simulatedReason) throw new Error(`Old-owner op was refused before submission, not by signature checks: ${rejection}`);
    results.oldOwner = { bundler: rejection, onchain: simulatedReason };

    // 5. The new owner rotates back and removes the guardians (one op).
    const recoveredSpec = kernelRecoveredAccountSpec({ node, account });
    results.restore = await send(
      '[5] New owner rotates the owner back to the dev EOA and removes the guardians',
      client(recoveredSpec, submitting),
      newOwner,
      [...ownerRotationCalls(owner.address, { account }), ...guardianUninstallCalls(account)],
    );
    stage = 'clean';
  } catch (error) {
    console.log(`\nFailure at stage "${stage}": ${maskSecrets(error.message)}`);
    await cleanup(stage, { account, owner, newOwner, rootSpec, client, submitting, send });
    throw error;
  }

  // 6. End state and read-only proofs.
  const endOwner = await readKernelOwner(node, account);
  const endGuardians = await readGuardianState(node, account);
  console.log(`\n[6] End state: owner ${endOwner.owner}; guardians active=${endGuardians.active} validationInstalled=${endGuardians.validationInstalled} recoveryAllowed=${endGuardians.recoveryAllowed} routed=${endGuardians.recoveryRouted} initialized=${endGuardians.validatorInitialized}`);
  if (endOwner.owner.toLowerCase() !== owner.address.toLowerCase() || endGuardians.validationInstalled || endGuardians.validatorInitialized || endGuardians.recoveryRouted || endGuardians.recoveryAllowed) {
    throw new Error('The account was not left as found');
  }
  const again = await signedRootOp(rootSpec, owner, account, [{ to: account, value: 0n, data: new Uint8Array(0) }], fees);
  const againSim = await simulateHandleOps(again, owner.address);
  console.log(`  original owner root op (simulated): ${againSim.ok ? 'accepted' : againSim.reason}`);
  if (!againSim.ok) throw new Error('Original owner cannot sign after the rotation back');
  const request2 = buildGuardianRecoveryRequest({
    chainId: CHAIN_ID,
    account,
    newOwner: newOwner.address,
    nonce: BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('getNonce(address,uint192)', [{ kind: 'address', value: account }, { kind: 'uint256', value: guardianNonceKey() }])) }, 'latest'])),
  });
  const after = guardianOp(account, request2, [signGuardianApproval(hi, toBytes(request2.approvalDigest))], lo, {
    callGasLimit: 300_000n,
    verificationGasLimit: 500_000n,
    preVerificationGas: 100_000n,
    ...feesOf(fees),
  });
  const afterSim = await simulateHandleOps(after, owner.address);
  console.log(`  guardian op after removal (simulated): ${afterSim.ok ? 'ACCEPTED (unexpected)' : afterSim.reason}`);
  if (afterSim.ok) throw new Error('Guardians can still act after removal');
  results.after = { originalOwner: 'accepted (simulated)', guardians: afterSim.reason };
  console.log(`  account balance now ${await nodeClient.getBalance(account)} wei; dev EOA ${await nodeClient.getBalance(owner.address)} wei`);

  console.log('\nRECOVERY SMOKE PASSED');
  console.log(JSON.stringify(results, null, 2));
}

function feesOf(fees) {
  return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
}

/** A root-signed op with fixed generous gas, for read-only simulation only (never sent). */
async function signedRootOp(spec, signer, account, calls, fees) {
  const nonce = BigInt(
    await node('eth_call', [
      { to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('getNonce(address,uint192)', [{ kind: 'address', value: account }, { kind: 'uint256', value: 0n }])) },
      'latest',
    ]),
  );
  const op = { sender: account, nonce, callData: encodeKernelExecute(calls), callGasLimit: 300_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n, ...feesOf(fees), signature: new Uint8Array(0) };
  return { ...op, signature: spec.signUserOpHash(signer, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) };
}

/** Restores the original owner and removes the guardians with whichever key owns the account now. */
async function cleanup(stage, { account, owner, newOwner, rootSpec, client, submitting, send }) {
  if (stage === 'clean') return;
  try {
    const current = (await readKernelOwner(node, account)).owner.toLowerCase();
    const guardianState = await readGuardianState(node, account);
    const calls = [];
    if (current === newOwner.address.toLowerCase()) calls.push(...ownerRotationCalls(owner.address, { account }));
    if (guardianState.validationInstalled || guardianState.validatorInitialized || guardianState.recoveryRouted) calls.push(...guardianUninstallCalls(account));
    if (calls.length === 0) return;
    const signer = current === newOwner.address.toLowerCase() ? newOwner : owner;
    const spec = current === newOwner.address.toLowerCase() ? kernelRecoveredAccountSpec({ node, account }) : rootSpec;
    await send(`CLEANUP signed by ${signer.address}`, client(spec, submitting), signer, calls);
  } catch (cleanupError) {
    console.log(`CLEANUP FAILED: ${maskSecrets(cleanupError.message)} — inspect ${account} manually`);
  }
}

/** Submits handleOps([op]) from the dev EOA (ERC-4337 permits any bundler). */
async function selfBundle(op, owner, fees) {
  const data = encodeHandleOps(op, owner.address);
  const gas = BigInt(await node('eth_estimateGas', [{ from: owner.address, to: ENTRYPOINT_V07, data: toHex(data) }]));
  const tx = signEip1559(
    { chainId: CHAIN_ID, nonce: await nodeClient.getTransactionCount(owner.address), ...feesOf(fees), gasLimit: (gas * 130n) / 100n, to: ENTRYPOINT_V07, value: 0n, data },
    owner,
  );
  const hash = await nodeClient.sendRawTransaction(tx.rawHex);
  console.log(`  self-bundled handleOps transaction: ${hash}`);
  const receipt = await waitForTx(hash);
  const userOpHash = toHex(getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID));
  const success = userOpEventSuccess(receipt.logs, userOpHash);
  console.log(`  handleOps status ${receipt.status}; UserOperationEvent success=${success}`);
  if (receipt.status !== '0x1' || success !== true) throw new Error('Self-bundled op failed');
  return { userOpHash, tx: hash };
}

(DRY_RUN ? dryRun() : liveRun()).catch((error) => {
  console.error(`Recovery smoke failed: ${maskSecrets(error.message)}`);
  process.exit(1);
});

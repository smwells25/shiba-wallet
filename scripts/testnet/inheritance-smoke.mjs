/**
 * Inheritance-switch smoke test on Sepolia (phase 14, item 4): an HEIR is a
 * guardian of ZeroDev's WeightedECDSAValidator installed on a Kernel v3.3
 * account with a LONG delay, so the heir can take the account over only
 * after approving on-chain and waiting out the delay, during which the owner
 * can veto. Everything is driven by engine code
 * (packages/chains-evm/src/kernel-recovery.ts); the contract facts each step
 * demonstrates are cited from WeightedECDSAValidator.sol and Kernel.sol at
 * kernel tag v3.3 (commit cd697c7e21715d015e0643af22310a99aa17433b).
 *
 * DRY RUN (INHERITANCE_SMOKE_DRY_RUN=1, the default when no bundler is set):
 * no keys from .dev-wallet, no bundler, nothing broadcast. Every scenario is
 * one read-only eth_simulateV1 request against the real EntryPoint v0.7,
 * Kernel v3.3, WeightedECDSAValidator, RecoveryAction and Circle's Sepolia
 * USDC, for the PUBLIC BIP-39 test mnemonic's undeployed Kernel account at
 * KERNEL_INDEX (default 30). Owner = index 0, heir = index 5, the heir's new
 * owner key = index 9. Block times are overridden to cross the delay.
 *   S1  setup; the heir signs AS THE ACCOUNT through ERC-1271 at once, and
 *       uses that to grant itself a USDC allowance with permit() and pull
 *       the account's USDC (state override gives the account 1,000 USDC);
 *       an operation without on-chain approval is refused; approveWithSig
 *       starts the clock; refused before the delay and one second before
 *       it ends; accepted at the end; the owner is then the heir's key.
 *   S2  the owner's veto during the delay: the takeover is refused.
 *   S3  the owner's veto AFTER the delay has passed but before execution:
 *       still refused.
 *   S4  renew() with the same heir is NOT a proof of life: the approved
 *       takeover still executes after the delay.
 *   S5  remove + re-install is NOT a proof of life: refused while removed,
 *       accepted again after the re-install (the proposal status survives).
 *   S5b a veto is accepted while the heir set is removed, and a re-install
 *       then cannot revive that proposal.
 *   S6  bumping the proposal's EntryPoint nonce lane invalidates THAT
 *       proposal only: a second approval on a lane the owner cannot guess
 *       (nonce mode byte 0x07, parallel key 0xabcd) still executes.
 *   S7  Kernel invalidateNonce disables the heir entirely (operation and
 *       ERC-1271), but also the wallet's own 0x01-envelope ERC-1271
 *       signatures — an emergency switch, not a proof of life.
 *   S8  a delay near 2^48 seconds WRAPS: validAfter = uint48(now + delay)
 *       truncates, so the takeover is valid immediately.
 *
 * LIVE (BUNDLER_URL or ZERODEV_PROJECT_ID set, INHERITANCE_SMOKE_LIVE=1):
 * on the dev seed's DEPLOYED Kernel account (index 2, 0x1D72…4106), with a
 * 10-minute delay and the dev seed's index-5 address as the heir:
 *   L0 approvals left by an earlier interrupted run (they survive the
 *      removal of the heir set and would revive on a re-install) are vetoed
 *      first, while no heir set is installed;
 *   L1 the owner installs the heir set (one root operation);
 *   L2 read-only: the heir's ERC-1271 signature is VALID at once, and a
 *      USDC permit the heir signs as the account passes eth_call;
 *   L3 the heir approves proposal P1 on-chain (approveWithSig, relayed by
 *      the dev EOA);
 *   L4 the transaction scan finds P1 from the validator's calldata alone;
 *   L5 the owner vetoes P1 (root operation);
 *   L6 the heir approves proposal P2 on another fresh lane; the takeover is
 *      refused before the delay (simulated);
 *   L7 after the delay the heir submits the takeover (the heir's EIP-191
 *      signature; the account pays its own gas);
 *   L8 the new owner (index 9) rotates the owner back to the dev EOA and
 *      removes the heir set in one operation;
 *   L9 end state read back; every hash re-read from the node.
 * If anything fails after L1 the script restores the original owner and
 * removes the heir set with whichever key owns the account.
 *
 * Environment:
 *   ZERODEV_PROJECT_ID / BUNDLER_URL   live only; never printed.
 *   NODE_URL                           optional; default public Sepolia RPC.
 *   KERNEL_INDEX                       dry run only (default 30).
 *   INHERITANCE_SMOKE_LIVE=1           required for the live run.
 *
 * Run from the repository root after `npm run build`:
 *   Dry run: node scripts/testnet/inheritance-smoke.mjs
 *   Live:    set -a; . .dev-wallet/env; set +a; INHERITANCE_SMOKE_LIVE=1 node scripts/testnet/inheritance-smoke.mjs
 * A live run writes its public record (hashes and addresses only) to
 * scripts/testnet/runs/ (git-ignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_RECOVERY_MODULES,
  KERNEL_V3_3,
  NodeClient,
  SmartAccountClient,
  buildGuardianRecoveryRequest,
  callDataAndNonceHash,
  createKernelAccountSpec,
  encodeApproveWithSig,
  encodeFunctionCall,
  encodeGuardianSignature,
  encodeKernelExecute,
  encodeRecoveryCallData,
  encodeVetoCall,
  getUserOpHash,
  guardianApprovalDigest,
  guardianInstallCalls,
  guardianNonceKey,
  guardianRenewCall,
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
  readGuardianState,
  readKernelOwner,
  readRecoveryProposal,
  recoveryCall,
  scanGuardianApprovals,
  signEip1559,
  signGuardianApproval,
  signGuardianUserOpHash,
  toBytes,
  toHex,
  typedDataDigest,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/11155111` : undefined);
const LIVE = process.env.INHERITANCE_SMOKE_LIVE === '1';
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const DRY_INDEX = BigInt(process.env.KERNEL_INDEX ?? '30');
const LIVE_ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const CHAIN_ID = 11155111n;
const ERC1271_MAGIC = '0x1626ba7e';
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Circle's Sepolia USDC (FiatTokenProxy); recorded in AGENTS.md from Circle's contract-address page. */
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
/** FiatToken's balanceAndBlacklistStates mapping slot, found by reading a known holder's balance on Sepolia. */
const USDC_BALANCE_SLOT = 9n;
const HEIR_INDEX = 5;
const HEIR_NEW_OWNER_INDEX = 9;
const DRY_DELAY = 30 * 86_400; // 30 days
const LIVE_DELAY = 600; // 10 minutes (test networks only)
const MAX_UINT48 = 2n ** 48n - 1n;

if (LIVE && !BUNDLER_URL) {
  console.error('A live run needs ZERODEV_PROJECT_ID or BUNDLER_URL.');
  process.exit(1);
}

const plainNode = httpTransport(NODE_URL);
/**
 * Public RPC endpoints drop a request now and then ("fetch failed"). Every
 * call this script makes is idempotent (reads, or re-sending the same signed
 * raw transaction), so a transport-level failure is retried up to three
 * times; JSON-RPC errors are not retried.
 */
async function node(method, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await plainNode(method, params);
    } catch (error) {
      const transport = /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|HTTP error 5\d\d|HTTP 5\d\d/i.test(String(error?.message ?? error));
      if (!transport || attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
const nodeClient = new NodeClient(node);

function maskSecrets(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) out = out.split(secret).join('<masked>');
  return out;
}

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
    'NotInitialized(address)',
    'AlreadyInitialized(address)',
  ].map((s) => [errorSelector(s), s]),
);

function decodeAbiString(hexBody, wordOffset) {
  const word = (i) => hexBody.slice(i * 64, i * 64 + 64);
  const strOffset = Number(BigInt('0x' + word(wordOffset))) / 32;
  const strLen = Number(BigInt('0x' + word(strOffset)));
  return Buffer.from(hexBody.slice((strOffset + 1) * 64, (strOffset + 1) * 64 + strLen * 2), 'hex').toString();
}

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

const HANDLE_OPS_SIG = 'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';

function encodeHandleOps(op, beneficiary) {
  return encodeFunctionCall(HANDLE_OPS_SIG, [
    {
      kind: 'array',
      items: [
        {
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
        },
      ],
    },
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

function revertDataOf(error) {
  const match = /(0x[0-9a-fA-F]{8,})/.exec(String(error?.message ?? error));
  return match ? match[1] : null;
}

async function simulateHandleOps(op, from) {
  const call = { from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x989680' };
  try {
    await rawRpc(NODE_URL, 'eth_call', [call, 'latest']);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeRevert(error.data ?? revertDataOf(error)) };
  }
}

function keyring(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry);
}

const GAS = {
  callGasLimit: 600_000n,
  verificationGasLimit: 1_500_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));

function signRootOp(op, owner, spec) {
  return { ...op, signature: spec.signUserOpHash(owner, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) };
}

/** A heir-submitted takeover for an on-chain-approved proposal: just the heir's EIP-191 userOpHash signature. */
function heirOp(account, nonce, callData, heir, gas = GAS) {
  const op = { sender: account, nonce, callData, ...gas, signature: new Uint8Array(0) };
  return { ...op, signature: encodeGuardianSignature([], signGuardianUserOpHash(heir, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID))) };
}

/** A nonce key on the guardian validator with an arbitrary Kernel mode byte and parallel key. */
function laneKey(modeByte, parallelKey) {
  const validator = BigInt(KERNEL_RECOVERY_MODULES.weightedEcdsaValidator);
  return (BigInt(modeByte) << 184n) | (1n << 176n) | (validator << 16n) | BigInt(parallelKey);
}

const isValidSignatureData = (hash, signature) =>
  toHex(
    encodeFunctionCall('isValidSignature(bytes32,bytes)', [
      { kind: 'fixedBytes', value: hash },
      { kind: 'bytes', value: signature },
    ]),
  );

/** The heir's ERC-1271 envelope: 0x01 || weighted validator || raw signature over Kernel's wrapped digest. */
function heirErc1271Signature(heir, account, hash) {
  const digest = kernelErc1271Digest(hash, { chainId: CHAIN_ID, account });
  return new Uint8Array([...kernelValidatorId(KERNEL_RECOVERY_MODULES.weightedEcdsaValidator), ...signGuardianApproval(heir, digest)]);
}

/** The owner's own envelope through the ECDSA validator (0x01 || validator || signature), as the wallet signs. */
function ownerErc1271Signature(owner, account, hash) {
  const digest = kernelErc1271Digest(hash, { chainId: CHAIN_ID, account });
  return new Uint8Array([...kernelValidatorId(KERNEL_V3_3.ecdsaValidator), ...signGuardianApproval(owner, digest)]);
}

/** USDC (FiatTokenV2_2) EIP-2612 permit digest; domain name and version read from the contract ("USDC", "2"). */
function usdcPermitDigest({ owner, spender, value, nonce, deadline }) {
  return typedDataDigest(
    { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: SEPOLIA_USDC },
    {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    'Permit',
    { owner, spender, value, nonce, deadline },
  );
}

function usdcBalanceSlot(holder) {
  const key = holder.slice(2).toLowerCase().padStart(64, '0') + USDC_BALANCE_SLOT.toString(16).padStart(64, '0');
  return toHex(keccak_256(toBytes('0x' + key)));
}

const ownerOfCall = (account) => ({
  to: KERNEL_V3_3.ecdsaValidator,
  data: toHex(encodeFunctionCall('ecdsaValidatorStorage(address)', [{ kind: 'address', value: account }])),
});
const ownerFrom = (call) => (call.status === '0x1' ? '0x' + call.returnData.slice(26) : `revert ${call.returnData}`);
const proposalCall = (account, hash) => ({
  to: KERNEL_RECOVERY_MODULES.weightedEcdsaValidator,
  data: toHex(
    encodeFunctionCall('proposalStatus(bytes32,address)', [
      { kind: 'fixedBytes', value: toBytes(hash) },
      { kind: 'address', value: account },
    ]),
  ),
});

function opResult(label, call, op, expectAccepted, failures, log) {
  const hash = toHex(getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID));
  const executed = call.status === '0x1' ? userOpEventSuccess(call.logs, hash) : null;
  const accepted = call.status === '0x1' && executed === true;
  const detail = call.status === '0x1' ? `UserOperationEvent success=${executed}` : describeRevert(call.error?.data ?? call.returnData);
  const ok = accepted === expectAccepted;
  if (!ok) failures.push(label);
  log.push({ label, expected: expectAccepted ? 'accepted' : 'refused', observed: accepted ? 'accepted' : 'refused', detail, pass: ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${accepted ? 'accepted' : 'refused'} (${detail})`);
}

function check(label, ok, detail, failures, log) {
  if (!ok) failures.push(label);
  log.push({ label, detail, pass: ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function dryRun() {
  const keys = keyring(PUBLIC_TEST_MNEMONIC);
  const owner = keys.getAccount('eip155:1', 0, 0);
  const heir = keys.getAccount('eip155:1', 0, HEIR_INDEX);
  const heirNewOwner = keys.getAccount('eip155:1', 0, HEIR_NEW_OWNER_INDEX);
  const spec = createKernelAccountSpec({ node, index: DRY_INDEX });
  const account = await spec.getAddress(owner);
  if ((await node('eth_getCode', [account, 'latest'])) !== '0x') throw new Error(`${account} is deployed; the dry run needs an undeployed account`);
  const latest = await node('eth_getBlockByNumber', ['latest', false]);
  const t0 = Number(BigInt(latest.timestamp));
  const failures = [];
  const log = [];
  const from = owner.address;
  const relayer = '0x000000000000000000000000000000000000bEEF';
  const handle = (op) => ({ from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' });
  const at = (t) => ({ time: hex(t) });
  const funded = { [account]: { balance: '0xde0b6b3a7640000' }, [from]: { balance: '0xde0b6b3a7640000' }, [relayer]: { balance: '0xde0b6b3a7640000' }, [heir.address]: { balance: '0xde0b6b3a7640000' } };
  const heirSet = (delaySeconds) => ({ guardians: [{ address: heir.address, weight: 1 }], threshold: 1, delaySeconds });
  const factory = await spec.getFactoryArgs(owner);
  const deployWith = (set) =>
    signRootOp({ sender: account, nonce: 0n, ...factory, callData: encodeKernelExecute(guardianInstallCalls(account, set, { owner: owner.address })), ...GAS }, owner, spec);
  const rootOp = (nonce, calls) => signRootOp({ sender: account, nonce, callData: encodeKernelExecute(calls), ...GAS }, owner, spec);
  const proposal = (nonce) =>
    buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account, newOwner: heirNewOwner.address, nonce, guardians: heirSet(DRY_DELAY).guardians });
  const approveCall = (request) => {
    const tx = encodeApproveWithSig(request, [signGuardianApproval(heir, toBytes(request.approvalDigest))]);
    return { from: relayer, to: tx.to, data: toHex(tx.data) };
  };
  const takeover = (request) => heirOp(account, BigInt(request.nonce), toBytes(request.callData), heir);
  // Pinned to the block whose timestamp is t0, so the overridden times stay ahead of the base block
  // even when a new block arrives during the run (eth_simulateV1 requires increasing timestamps).
  const simulate = async (blocks) => node('eth_simulateV1', [{ blockStateCalls: blocks }, latest.number]);
  const lane0 = guardianNonceKey() << 64n;
  const statusOf = (c) => (c.status === '0x1' ? { status: Number(word(c.returnData, 0)), validAfter: word(c.returnData, 1) } : null);

  console.log(`DRY RUN (public test mnemonic). Kernel account (index ${DRY_INDEX}) ${account}`);
  console.log(`Owner ${owner.address}; heir ${heir.address} (weight 1, threshold 1); heir's new owner ${heirNewOwner.address}`);
  console.log(`Delay ${DRY_DELAY} s (30 days). Base block time ${t0}.`);

  // ---------------- S1 ----------------
  {
    console.log('\n[S1] Setup, the heir’s immediate signing power, approval, delay, takeover');
    const request = proposal(lane0);
    const approveTime = t0 + 48;
    const validAfter = BigInt(approveTime + DRY_DELAY);
    const probeHash = keccak_256(utf8ToBytes('shiba-wallet inheritance smoke: ERC-1271 probe'));
    const amount = 1_000_000_000n; // 1,000 USDC (6 decimals)
    const deadline = BigInt(t0 + 86_400);
    const permitDigest = usdcPermitDigest({ owner: account, spender: heir.address, value: amount, nonce: 0n, deadline });
    const permitSig = heirErc1271Signature(heir, account, permitDigest);
    const permitData = toHex(
      encodeFunctionCall('permit(address,address,uint256,uint256,bytes)', [
        { kind: 'address', value: account },
        { kind: 'address', value: heir.address },
        { kind: 'uint256', value: amount },
        { kind: 'uint256', value: deadline },
        { kind: 'bytes', value: permitSig },
      ]),
    );
    const usdcRead = (sig, args) => ({ to: SEPOLIA_USDC, data: toHex(encodeFunctionCall(sig, args)) });
    const blocks = [
      {
        blockOverrides: at(t0 + 12),
        stateOverrides: { ...funded, [SEPOLIA_USDC]: { stateDiff: { [usdcBalanceSlot(account)]: '0x' + amount.toString(16).padStart(64, '0') } } },
        calls: [handle(deployWith(heirSet(DRY_DELAY)))],
      },
      {
        blockOverrides: at(t0 + 24),
        calls: [
          { from, to: account, data: isValidSignatureData(probeHash, heirErc1271Signature(heir, account, probeHash)) },
          { from: heir.address, to: SEPOLIA_USDC, data: permitData },
          usdcRead('allowance(address,address)', [{ kind: 'address', value: account }, { kind: 'address', value: heir.address }]),
          {
            from: heir.address,
            to: SEPOLIA_USDC,
            data: toHex(
              encodeFunctionCall('transferFrom(address,address,uint256)', [
                { kind: 'address', value: account },
                { kind: 'address', value: heir.address },
                { kind: 'uint256', value: amount },
              ]),
            ),
          },
          usdcRead('balanceOf(address)', [{ kind: 'address', value: account }]),
          usdcRead('balanceOf(address)', [{ kind: 'address', value: heir.address }]),
        ],
      },
      { blockOverrides: at(t0 + 36), calls: [handle(takeover(request))] },
      { blockOverrides: at(approveTime), calls: [approveCall(request), proposalCall(account, request.callDataAndNonceHash)] },
      { blockOverrides: at(approveTime + 60), calls: [handle(takeover(request))] },
      { blockOverrides: at(Number(validAfter) - 1), calls: [handle(takeover(request))] },
      { blockOverrides: at(Number(validAfter)), calls: [handle(takeover(request)), ownerOfCall(account), proposalCall(account, request.callDataAndNonceHash)] },
    ];
    const r = await simulate(blocks);
    opResult('deploy + install the heir set (owner, root validator)', r[0].calls[0], deployWith(heirSet(DRY_DELAY)), true, failures, log);
    const erc = r[1].calls[0];
    check('the heir signs AS THE ACCOUNT through ERC-1271 immediately', erc.status === '0x1' && erc.returnData.slice(0, 10).toLowerCase() === ERC1271_MAGIC, erc.status === '0x1' ? `isValidSignature returned ${erc.returnData.slice(0, 10)}` : describeRevert(erc.returnData), failures, log);
    check('USDC permit(owner = the account, spender = the heir) with the heir’s ERC-1271 signature', r[1].calls[1].status === '0x1', `status ${r[1].calls[1].status}${r[1].calls[1].status !== '0x1' ? ' ' + describeRevert(r[1].calls[1].returnData) : ''}`, failures, log);
    check('allowance(account, heir) after the permit', r[1].calls[2].status === '0x1' && word(r[1].calls[2].returnData, 0) === amount, `${r[1].calls[2].status === '0x1' ? word(r[1].calls[2].returnData, 0) : 'revert'} base units`, failures, log);
    check('the heir pulls the account’s USDC with transferFrom on day one', r[1].calls[3].status === '0x1' && word(r[1].calls[4].returnData, 0) === 0n && word(r[1].calls[5].returnData, 0) >= amount, `transferFrom status ${r[1].calls[3].status}; account ${word(r[1].calls[4].returnData, 0)}, heir ${word(r[1].calls[5].returnData, 0)} base units`, failures, log);
    opResult('takeover with no on-chain approval (delay > 0 forbids the immediate path)', r[2].calls[0], takeover(request), false, failures, log);
    check('approveWithSig by an unrelated relayer starts the clock', r[3].calls[0].status === '0x1', `status ${r[3].calls[0].status}`, failures, log);
    const st = statusOf(r[3].calls[1]);
    check('proposal Approved with validAfter = approval time + delay', st?.status === 1 && st.validAfter === validAfter, st ? `status ${st.status}, validAfter ${st.validAfter} (expected ${validAfter})` : 'revert', failures, log);
    opResult('takeover one minute after approval', r[4].calls[0], takeover(request), false, failures, log);
    opResult('takeover one second before the delay ends', r[5].calls[0], takeover(request), false, failures, log);
    opResult('takeover when the delay has ended (block time = validAfter)', r[6].calls[0], takeover(request), true, failures, log);
    check('owner after the takeover is the heir’s new key', ownerFrom(r[6].calls[1]).toLowerCase() === heirNewOwner.address.toLowerCase(), ownerFrom(r[6].calls[1]), failures, log);
    const st2 = statusOf(r[6].calls[2]);
    check('proposal Executed', st2?.status === 3, st2 ? `status ${st2.status}` : 'revert', failures, log);
  }

  // Shared prefix for S2–S7: deploy + install, then the heir approves on lane 0 at t0 + 24.
  const request = proposal(lane0);
  const approveTime = t0 + 24;
  const validAfter = approveTime + DRY_DELAY;
  const prefix = [
    { blockOverrides: at(t0 + 12), stateOverrides: funded, calls: [handle(deployWith(heirSet(DRY_DELAY)))] },
    { blockOverrides: at(approveTime), calls: [approveCall(request)] },
  ];
  const prefixOk = (r, label) => {
    const ok = r[0].calls[0].status === '0x1' && userOpEventSuccess(r[0].calls[0].logs, toHex(getUserOpHash(deployWith(heirSet(DRY_DELAY)), ENTRYPOINT_V07, CHAIN_ID))) === true && r[1].calls[0].status === '0x1';
    check(`${label}: setup and the heir's approval`, ok, ok ? 'deployed, installed, approved' : 'prefix failed', failures, log);
  };

  // ---------------- S2 ----------------
  {
    console.log('\n[S2] The owner vetoes during the delay');
    const veto = rootOp(1n, [encodeVetoCall(request.callDataAndNonceHash)]);
    const r = await simulate([
      ...prefix,
      { blockOverrides: at(approveTime + 600), calls: [handle(veto), proposalCall(account, request.callDataAndNonceHash)] },
      { blockOverrides: at(validAfter + 1), calls: [handle(takeover(request)), ownerOfCall(account)] },
    ]);
    prefixOk(r, 'S2');
    opResult('owner veto (root operation calling veto(hash))', r[2].calls[0], veto, true, failures, log);
    const st = statusOf(r[2].calls[1]);
    check('proposal Rejected', st?.status === 2, st ? `status ${st.status}` : 'revert', failures, log);
    opResult('takeover after the delay (vetoed)', r[3].calls[0], takeover(request), false, failures, log);
    check('owner unchanged', ownerFrom(r[3].calls[1]).toLowerCase() === owner.address.toLowerCase(), ownerFrom(r[3].calls[1]), failures, log);
  }

  // ---------------- S3 ----------------
  {
    console.log('\n[S3] The owner vetoes AFTER the delay has passed, before the heir executes');
    const veto = rootOp(1n, [encodeVetoCall(request.callDataAndNonceHash)]);
    const r = await simulate([
      ...prefix,
      { blockOverrides: at(validAfter + 100), calls: [handle(veto)] },
      { blockOverrides: at(validAfter + 200), calls: [handle(takeover(request)), ownerOfCall(account)] },
    ]);
    prefixOk(r, 'S3');
    opResult('owner veto after the delay ended', r[2].calls[0], veto, true, failures, log);
    opResult('takeover after a late veto', r[3].calls[0], takeover(request), false, failures, log);
    check('owner unchanged', ownerFrom(r[3].calls[1]).toLowerCase() === owner.address.toLowerCase(), ownerFrom(r[3].calls[1]), failures, log);
  }

  // ---------------- S4 ----------------
  {
    console.log('\n[S4] renew() with the same heir is NOT a proof of life');
    const renew = rootOp(1n, [guardianRenewCall(heirSet(DRY_DELAY), { account, owner: owner.address })]);
    const r = await simulate([
      ...prefix,
      { blockOverrides: at(approveTime + 600), calls: [handle(renew), proposalCall(account, request.callDataAndNonceHash)] },
      { blockOverrides: at(validAfter), calls: [handle(takeover(request)), ownerOfCall(account)] },
    ]);
    prefixOk(r, 'S4');
    opResult('owner renews the heir set (same heir, same delay)', r[2].calls[0], renew, true, failures, log);
    const st = statusOf(r[2].calls[1]);
    check('proposal still Approved after renew, validAfter unchanged', st?.status === 1 && st.validAfter === BigInt(validAfter), st ? `status ${st.status}, validAfter ${st.validAfter}` : 'revert', failures, log);
    opResult('takeover after the ORIGINAL delay despite the renew', r[3].calls[0], takeover(request), true, failures, log);
    check('owner is the heir’s key', ownerFrom(r[3].calls[1]).toLowerCase() === heirNewOwner.address.toLowerCase(), ownerFrom(r[3].calls[1]), failures, log);
  }

  // ---------------- S5 ----------------
  {
    console.log('\n[S5] Remove + re-install is NOT a proof of life');
    const remove = rootOp(1n, guardianUninstallCalls(account));
    const reinstall = rootOp(2n, guardianInstallCalls(account, heirSet(DRY_DELAY), { owner: owner.address }));
    const r = await simulate([
      ...prefix,
      { blockOverrides: at(approveTime + 600), calls: [handle(remove), proposalCall(account, request.callDataAndNonceHash)] },
      { blockOverrides: at(validAfter + 10), calls: [handle(takeover(request))] },
      { blockOverrides: at(validAfter + 20), calls: [handle(reinstall)] },
      { blockOverrides: at(validAfter + 30), calls: [handle(takeover(request)), ownerOfCall(account)] },
    ]);
    prefixOk(r, 'S5');
    opResult('owner removes the heir set', r[2].calls[0], remove, true, failures, log);
    const st = statusOf(r[2].calls[1]);
    check('proposal status survives the removal', st?.status === 1, st ? `status ${st.status}, validAfter ${st.validAfter}` : 'revert', failures, log);
    opResult('takeover while the heir set is removed', r[3].calls[0], takeover(request), false, failures, log);
    opResult('owner re-installs the same heir', r[4].calls[0], reinstall, true, failures, log);
    opResult('takeover after the re-install (the old approval revives)', r[5].calls[0], takeover(request), true, failures, log);
    check('owner is the heir’s key', ownerFrom(r[5].calls[1]).toLowerCase() === heirNewOwner.address.toLowerCase(), ownerFrom(r[5].calls[1]), failures, log);
  }

  // ---------------- S5b ----------------
  {
    console.log('\n[S5b] A veto works while the heir set is removed, so a re-install cannot revive that approval');
    const remove = rootOp(1n, guardianUninstallCalls(account));
    const veto = rootOp(2n, [encodeVetoCall(request.callDataAndNonceHash)]);
    const reinstall = rootOp(3n, guardianInstallCalls(account, heirSet(DRY_DELAY), { owner: owner.address }));
    const r = await simulate([
      ...prefix,
      { blockOverrides: at(approveTime + 600), calls: [handle(remove)] },
      { blockOverrides: at(approveTime + 700), calls: [handle(veto), proposalCall(account, request.callDataAndNonceHash)] },
      { blockOverrides: at(validAfter + 20), calls: [handle(reinstall)] },
      { blockOverrides: at(validAfter + 30), calls: [handle(takeover(request)), ownerOfCall(account)] },
    ]);
    prefixOk(r, 'S5b');
    opResult('owner removes the heir set', r[2].calls[0], remove, true, failures, log);
    opResult('owner vetoes the known proposal while the set is removed', r[3].calls[0], veto, true, failures, log);
    const st = statusOf(r[3].calls[1]);
    check('proposal Rejected', st?.status === 2, st ? `status ${st.status}` : 'revert', failures, log);
    opResult('owner re-installs the same heir', r[4].calls[0], reinstall, true, failures, log);
    opResult('takeover after the re-install (vetoed before)', r[5].calls[0], takeover(request), false, failures, log);
    check('owner unchanged', ownerFrom(r[5].calls[1]).toLowerCase() === owner.address.toLowerCase(), ownerFrom(r[5].calls[1]), failures, log);
  }

  // ---------------- S6 ----------------
  {
    console.log('\n[S6] Bumping the proposal’s nonce lane kills only that proposal');
    // A second proposal on a lane the app never uses: mode byte 0x07 (Kernel
    // treats every mode except 0x01 ENABLE as the default mode), parallel key 0xabcd.
    const oddKey = laneKey(0x07, 0xabcd);
    const oddNonce = oddKey << 64n;
    const oddCallData = encodeRecoveryCallData(heirNewOwner.address, { account });
    const oddHash = callDataAndNonceHash(account, oddCallData, oddNonce);
    const oddApproval = encodeApproveWithSig(
      { ...request, callDataAndNonceHash: toHex(oddHash) },
      [signGuardianApproval(heir, guardianApprovalDigest(CHAIN_ID, oddHash))],
    );
    const bump = rootOp(1n, [
      { to: ENTRYPOINT_V07, value: 0n, data: encodeFunctionCall('incrementNonce(uint192)', [{ kind: 'uint256', value: guardianNonceKey() }]) },
    ]);
    const oddTakeover = heirOp(account, oddNonce, oddCallData, heir);
    const r = await simulate([
      ...prefix,
      { blockOverrides: at(approveTime + 1), calls: [{ from: relayer, to: oddApproval.to, data: toHex(oddApproval.data) }] },
      { blockOverrides: at(approveTime + 600), calls: [handle(bump)] },
      { blockOverrides: at(validAfter + 1), calls: [handle(takeover(request))] },
      { blockOverrides: at(validAfter + 2), calls: [handle(oddTakeover), ownerOfCall(account)] },
    ]);
    prefixOk(r, 'S6');
    check('the heir approves a second proposal on lane (mode 0x07, key 0xabcd)', r[2].calls[0].status === '0x1', `status ${r[2].calls[0].status}`, failures, log);
    opResult('owner increments the EntryPoint nonce of guardian lane 0', r[3].calls[0], bump, true, failures, log);
    opResult('takeover on the bumped lane', r[4].calls[0], takeover(request), false, failures, log);
    opResult('takeover on the lane the owner could not know', r[5].calls[0], oddTakeover, true, failures, log);
    check('owner is the heir’s key', ownerFrom(r[5].calls[1]).toLowerCase() === heirNewOwner.address.toLowerCase(), ownerFrom(r[5].calls[1]), failures, log);
  }

  // ---------------- S7 ----------------
  {
    console.log('\n[S7] Kernel invalidateNonce disables the heir — and the wallet’s own 0x01 envelope');
    const read = await simulate([
      ...prefix,
      { blockOverrides: at(approveTime + 1), calls: [{ to: account, data: toHex(encodeFunctionCall('currentNonce()', [])) }] },
    ]);
    const current = word(read[2].calls[0].returnData, 0);
    const invalidate = rootOp(1n, [{ to: account, value: 0n, data: encodeFunctionCall('invalidateNonce(uint32)', [{ kind: 'uint256', value: current + 1n }]) }]);
    const probeHash = keccak_256(utf8ToBytes('shiba-wallet inheritance smoke: after invalidateNonce'));
    const plainRoot = rootOp(2n, [{ to: account, value: 0n, data: new Uint8Array(0) }]);
    const r = await simulate([
      ...prefix,
      { blockOverrides: at(approveTime + 600), calls: [handle(invalidate)] },
      {
        blockOverrides: at(validAfter + 1),
        calls: [
          handle(takeover(request)),
          { from, to: account, data: isValidSignatureData(probeHash, heirErc1271Signature(heir, account, probeHash)) },
          { from, to: account, data: isValidSignatureData(probeHash, ownerErc1271Signature(owner, account, probeHash)) },
          handle(plainRoot),
        ],
      },
    ]);
    prefixOk(r, 'S7');
    check(`currentNonce() after setup`, current > 0n, `${current}`, failures, log);
    opResult(`owner calls invalidateNonce(${current + 1n})`, r[2].calls[0], invalidate, true, failures, log);
    opResult('takeover after invalidateNonce', r[3].calls[0], takeover(request), false, failures, log);
    const heirSig = r[3].calls[1];
    check('heir ERC-1271 after invalidateNonce', !(heirSig.status === '0x1' && heirSig.returnData.slice(0, 10) === ERC1271_MAGIC), heirSig.status === '0x1' ? `returned ${heirSig.returnData.slice(0, 10)}` : describeRevert(heirSig.returnData), failures, log);
    const ownerSig = r[3].calls[2];
    check('the wallet’s own 0x01-envelope ERC-1271 after invalidateNonce (side effect)', !(ownerSig.status === '0x1' && ownerSig.returnData.slice(0, 10) === ERC1271_MAGIC), ownerSig.status === '0x1' ? `returned ${ownerSig.returnData.slice(0, 10)}` : describeRevert(ownerSig.returnData), failures, log);
    opResult('owner root operation still works', r[3].calls[3], plainRoot, true, failures, log);
  }

  // ---------------- S8 ----------------
  {
    console.log('\n[S8] A delay near 2^48 seconds wraps around');
    const wrapSet = heirSet(Number(MAX_UINT48));
    const deploy = deployWith(wrapSet);
    const wrapRequest = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account, newOwner: heirNewOwner.address, nonce: lane0, guardians: wrapSet.guardians });
    const tx = encodeApproveWithSig(wrapRequest, [signGuardianApproval(heir, toBytes(wrapRequest.approvalDigest))]);
    const wrapTakeover = heirOp(account, lane0, toBytes(wrapRequest.callData), heir);
    const tApprove = t0 + 24;
    const expected = (BigInt(tApprove) + MAX_UINT48) % 2n ** 48n;
    const r = await simulate([
      { blockOverrides: at(t0 + 12), stateOverrides: funded, calls: [handle(deploy)] },
      { blockOverrides: at(tApprove), calls: [{ from: relayer, to: tx.to, data: toHex(tx.data) }, proposalCall(account, wrapRequest.callDataAndNonceHash)] },
      { blockOverrides: at(tApprove + 12), calls: [handle(wrapTakeover), ownerOfCall(account)] },
    ]);
    opResult(`install with delay 2^48 - 1 s (the engine's validateGuardianSet accepts it)`, r[0].calls[0], deploy, true, failures, log);
    const st = statusOf(r[1].calls[1]);
    check('validAfter wrapped to approval time - 1', st?.status === 1 && st.validAfter === expected, st ? `validAfter ${st.validAfter} (approval time ${tApprove})` : 'revert', failures, log);
    opResult('takeover 12 seconds after approval', r[2].calls[0], wrapTakeover, true, failures, log);
  }

  if (failures.length) throw new Error(`Dry run expectations not met: ${failures.join('; ')}`);
  console.log(`\nDRY RUN PASSED (${log.length} checks) against the real EntryPoint v0.7, Kernel v3.3, WeightedECDSAValidator,`);
  console.log('RecoveryAction and Sepolia USDC (simulated blocks; nothing was broadcast).');
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

async function waitForTx(hash) {
  for (let i = 0; i < 90; i++) {
    let receipt = null;
    try {
      receipt = await node('eth_getTransactionReceipt', [hash]);
    } catch {
      // keep polling
    }
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

async function liveRun() {
  const record = { startedAt: new Date().toISOString(), chainId: CHAIN_ID.toString(), steps: [] };
  const note = (step, data) => {
    record.steps.push({ step, ...data });
    console.log(`  ${step}: ${JSON.stringify(data)}`);
  };
  const keys = keyring(readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim());
  const owner = keys.getAccount('eip155:1', 0, 0);
  const heir = keys.getAccount('eip155:1', 0, HEIR_INDEX);
  const newOwner = keys.getAccount('eip155:1', 0, HEIR_NEW_OWNER_INDEX);
  if ((await nodeClient.chainId()) !== CHAIN_ID) throw new Error('Not Sepolia');
  await verifyKernelDeployment(node);
  const rootSpec = createKernelAccountSpec({ node, index: 2n });
  const account = await rootSpec.getAddress(owner);
  if (account.toLowerCase() !== LIVE_ACCOUNT.toLowerCase()) throw new Error(`Index-2 account is ${account}, expected ${LIVE_ACCOUNT}`);
  const start = await readKernelOwner(node, account);
  if (start.owner.toLowerCase() !== owner.address.toLowerCase()) throw new Error(`Account owned by ${start.owner}, not the dev EOA; refusing`);
  const startGuardians = await readGuardianState(node, account);
  if (startGuardians.validatorInitialized || startGuardians.validationInstalled || startGuardians.recoveryRouted) {
    throw new Error('Guardian modules are already configured on the account; refusing');
  }
  Object.assign(record, { account, owner: owner.address, heir: heir.address, heirNewOwner: newOwner.address, delaySeconds: LIVE_DELAY });
  console.log(`Account ${account}; owner ${owner.address}; heir (index ${HEIR_INDEX}) ${heir.address}; heir's new owner (index ${HEIR_NEW_OWNER_INDEX}) ${newOwner.address}`);
  const balances = async () => ({
    account: (await nodeClient.getBalance(account)).toString(),
    deposit: BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: account }])) }, 'latest'])).toString(),
    devEoa: (await nodeClient.getBalance(owner.address)).toString(),
  });
  record.balancesBefore = await balances();
  console.log(`Balances before: ${JSON.stringify(record.balancesBefore)}`);

  const bundlerTransport = httpTransport(BUNDLER_URL);
  const bundlerCall = async (method, params) => {
    try {
      return await bundlerTransport(method, params);
    } catch (error) {
      throw new Error(maskSecrets(error.message));
    }
  };
  const fees = await nodeClient.suggestFees();
  try {
    const standard = (await bundlerCall('pimlico_getUserOperationGasPrice', []))?.standard;
    if (standard) {
      // Double the bundler's standard tier: its floor moves quickly (AGENTS.md, phase 13 fee-floor record).
      const max = (a, b) => (a > b ? a : b);
      fees.maxFeePerGas = max(fees.maxFeePerGas, BigInt(standard.maxFeePerGas) * 2n);
      fees.maxPriorityFeePerGas = max(fees.maxPriorityFeePerGas, BigInt(standard.maxPriorityFeePerGas) * 2n);
    }
  } catch {
    // keep the node suggestion
  }
  const submitting = async (method, params) => {
    if (method === 'eth_sendUserOperation') {
      const r = params[0];
      const op = {
        sender: r.sender,
        nonce: BigInt(r.nonce),
        callData: toBytes(r.callData),
        callGasLimit: BigInt(r.callGasLimit),
        verificationGasLimit: BigInt(r.verificationGasLimit),
        preVerificationGas: BigInt(r.preVerificationGas),
        maxFeePerGas: BigInt(r.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas),
        signature: toBytes(r.signature),
      };
      const sim = await simulateHandleOps(op, owner.address);
      if (!sim.ok) throw new Error(`Preflight handleOps simulation failed: ${sim.reason}`);
    }
    return bundlerCall(method, params);
  };
  const padding = { verification: 130, call: 130, preVerification: 110 };
  const client = (spec, routedNode = node) =>
    new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: submitting, node: routedNode, spec, gasPaddingPct: padding, depositTopUpVerificationGas: 40_000n });
  async function send(step, c, signer, calls) {
    console.log(`\n${step}`);
    const { userOpHash } = await c.sendCalls(signer, calls, fees);
    const receipt = await c.waitForReceipt(userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
    const success = receipt?.success === true || receipt?.success === '0x1';
    const tx = receipt?.receipt?.transactionHash ?? null;
    note(step, { userOpHash, tx, success });
    if (!success) throw new Error(`UserOperation ${userOpHash} did not succeed`);
    return { userOpHash, tx };
  }
  async function relay(step, call) {
    console.log(`\n${step}`);
    const gas = BigInt(await node('eth_estimateGas', [{ from: owner.address, to: call.to, data: toHex(call.data) }]));
    const f = await nodeClient.suggestFees();
    const tx = signEip1559({ chainId: CHAIN_ID, nonce: await nodeClient.getTransactionCount(owner.address), ...f, gasLimit: (gas * 130n) / 100n, to: call.to, value: 0n, data: call.data }, owner);
    let hash = tx.txHash;
    try {
      hash = await nodeClient.sendRawTransaction(tx.rawHex);
    } catch (error) {
      // A retried send of the same signed bytes may answer "already known": the transaction is out.
      if (!/already known/i.test(String(error?.message ?? error))) throw error;
    }
    if (hash.toLowerCase() !== tx.txHash.toLowerCase()) throw new Error(`Node returned ${hash}, expected ${tx.txHash}`);
    const receipt = await waitForTx(hash);
    note(step, { tx: hash, status: receipt.status, block: BigInt(receipt.blockNumber).toString() });
    if (receipt.status !== '0x1') throw new Error(`${step} failed`);
    return { hash, block: BigInt(receipt.blockNumber) };
  }
  const set = { guardians: [{ address: heir.address, weight: 1 }], threshold: 1, delaySeconds: LIVE_DELAY };
  const guardianNonce = async (key) =>
    BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data: toHex(encodeFunctionCall('getNonce(address,uint192)', [{ kind: 'address', value: account }, { kind: 'uint256', value: key }])) }, 'latest']));
  /** The executable proposal for the heir's new owner on each of the app's 16 guardian lanes. */
  const laneProposals = async () => {
    const out = [];
    for (let lane = 0; lane < 16; lane++) {
      const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account, newOwner: newOwner.address, nonce: await guardianNonce(guardianNonceKey(KERNEL_RECOVERY_MODULES, lane)), guardians: set.guardians });
      out.push({ lane, request, state: await readRecoveryProposal(node, account, request.callDataAndNonceHash) });
    }
    return out;
  };

  // L0: an approval left by an earlier, interrupted run survives the removal
  // of the heir set and would REVIVE when the same heir is installed again
  // (dry run S5). Veto every such approval first — the veto works while the
  // set is removed (dry run S5b).
  const leftovers = (await laneProposals()).filter((p) => p.state.status === 'approved');
  if (leftovers.length) {
    note('L0 leftover approvals found', { proposals: leftovers.map((p) => ({ lane: p.lane, proposal: p.request.callDataAndNonceHash, validAfter: p.state.validAfter })) });
    await send('L0 owner vetoes the leftover approvals while no heir set is installed', client(rootSpec), owner, leftovers.map((p) => encodeVetoCall(p.request.callDataAndNonceHash)));
    for (const p of leftovers) note('L0 after veto', { lane: p.lane, status: (await readRecoveryProposal(node, account, p.request.callDataAndNonceHash)).status });
  }
  const fresh = (await laneProposals()).filter((p) => p.state.status === 'ongoing' && p.state.approvedWeight === 0);
  if (fresh.length < 2) throw new Error('Fewer than two fresh guardian lanes');
  const [laneA, laneB] = fresh;
  note('lanes', { p1: laneA.lane, p2: laneB.lane });

  let stage = 'clean';
  try {
    // L1
    const install = await prepareGuardianInstall(node, { account, set });
    await send('L1 owner installs the heir set (10-minute delay)', client(rootSpec), owner, install.calls);
    stage = 'heirs';
    const st = await readGuardianState(node, account);
    note('L1 read-back', { active: st.active, heirs: st.set?.guardians.map((g) => `${g.address}:${g.weight}`), threshold: st.set?.threshold, delay: st.set?.delaySeconds });
    if (!st.active || st.set?.delaySeconds !== LIVE_DELAY) throw new Error('Heir set not active after install');

    // L2 read-only risk demonstration.
    console.log('\nL2 the heir signs as the account (read-only)');
    const probeHash = keccak_256(utf8ToBytes('shiba-wallet inheritance live: ERC-1271 probe'));
    const erc = await rawRpc(NODE_URL, 'eth_call', [{ to: account, data: isValidSignatureData(probeHash, heirErc1271Signature(heir, account, probeHash)) }, 'latest']);
    note('L2 heir ERC-1271', { result: erc.slice(0, 10), valid: erc.slice(0, 10).toLowerCase() === ERC1271_MAGIC });
    if (erc.slice(0, 10).toLowerCase() !== ERC1271_MAGIC) throw new Error('Heir ERC-1271 probe was not valid');
    const nonceWords = await node('eth_call', [{ to: SEPOLIA_USDC, data: toHex(encodeFunctionCall('nonces(address)', [{ kind: 'address', value: account }])) }, 'latest']);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const permitSig = heirErc1271Signature(heir, account, usdcPermitDigest({ owner: account, spender: heir.address, value: 1_000_000n, nonce: BigInt(nonceWords), deadline }));
    let permitResult;
    try {
      await rawRpc(NODE_URL, 'eth_call', [
        {
          from: heir.address,
          to: SEPOLIA_USDC,
          data: toHex(encodeFunctionCall('permit(address,address,uint256,uint256,bytes)', [
            { kind: 'address', value: account },
            { kind: 'address', value: heir.address },
            { kind: 'uint256', value: 1_000_000n },
            { kind: 'uint256', value: deadline },
            { kind: 'bytes', value: permitSig },
          ])),
        },
        'latest',
      ]);
      permitResult = 'passes eth_call';
    } catch (error) {
      permitResult = `reverted: ${describeRevert(error.data ?? revertDataOf(error))}`;
    }
    note('L2 heir-signed USDC permit for the account (eth_call only, never sent)', { result: permitResult });
    if (permitResult !== 'passes eth_call') throw new Error('USDC permit did not pass eth_call');

    // L3
    const p1 = laneA.request;
    const scanFrom = BigInt(await node('eth_blockNumber', []));
    const a1 = await relay(`L3 heir approves P1 on guardian lane ${laneA.lane} (approveWithSig, relayed by the dev EOA)`, encodeApproveWithSig(p1, [signGuardianApproval(heir, toBytes(p1.approvalDigest))]));
    const p1State = await readRecoveryProposal(node, account, p1.callDataAndNonceHash);
    note('L3 P1 on-chain', { proposal: p1.callDataAndNonceHash, status: p1State.status, validAfter: p1State.validAfter });

    // L4
    console.log('\nL4 scan the blocks since before the approval for approvals naming the account');
    const found = await scanGuardianApprovals(node, { account, chainId: CHAIN_ID, fromBlock: scanFrom, toBlock: a1.block });
    note('L4 scan', { blocks: `${scanFrom}-${a1.block}`, found: found.approvals.map((x) => ({ proposal: x.proposalHash, tx: x.txHash, approvers: x.approvers })) });
    if (!found.approvals.some((x) => x.proposalHash.toLowerCase() === p1.callDataAndNonceHash.toLowerCase())) throw new Error('Scan did not find P1');

    // L5
    await send('L5 owner vetoes P1', client(rootSpec), owner, [encodeVetoCall(p1.callDataAndNonceHash)]);
    note('L5 P1 after veto', { status: (await readRecoveryProposal(node, account, p1.callDataAndNonceHash)).status });

    // L6
    const p2 = laneB.request;
    await relay(`L6 heir approves P2 on guardian lane ${laneB.lane}`, encodeApproveWithSig(p2, [signGuardianApproval(heir, toBytes(p2.approvalDigest))]));
    const p2State = await readRecoveryProposal(node, account, p2.callDataAndNonceHash);
    note('L6 P2 on-chain', { proposal: p2.callDataAndNonceHash, status: p2State.status, validAfter: p2State.validAfter });
    const early = heirOp(account, BigInt(p2.nonce), toBytes(p2.callData), heir, { callGasLimit: 300_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    const earlySim = await simulateHandleOps(early, owner.address);
    note('L6 takeover before the delay (handleOps eth_call)', { result: earlySim.ok ? 'ACCEPTED (unexpected)' : earlySim.reason });
    if (earlySim.ok) throw new Error('Takeover accepted before the delay');

    // L7
    const waitMs = (p2State.validAfter + 15) * 1000 - Date.now();
    if (waitMs > 0) {
      console.log(`\nWaiting ${Math.ceil(waitMs / 1000)} s for the delay to end…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    const spec = kernelGuardianRecoverySpec({ request: p2, approvals: [], submitter: heir.address });
    await send('L7 heir submits the takeover after the delay', client(spec), heir, [recoveryCall(p2)]);
    stage = 'taken';
    const after = await readKernelOwner(node, account);
    note('L7 owner after takeover', { owner: after.owner });
    if (after.owner.toLowerCase() !== newOwner.address.toLowerCase()) throw new Error('Owner did not change');

    // L8
    await send('L8 heir’s new owner rotates back to the dev EOA and removes the heir set', client(kernelRecoveredAccountSpec({ node, account })), newOwner, [
      ...ownerRotationCalls(owner.address, { account }),
      ...guardianUninstallCalls(account),
    ]);
    stage = 'clean';
  } catch (error) {
    console.log(`\nFailure at stage "${stage}": ${maskSecrets(error.message)}`);
    await cleanup(stage, { account, owner, newOwner, rootSpec, client, send });
    record.error = maskSecrets(error.message);
    writeRecord(record);
    throw error;
  }
  // L9
  const end = await readKernelOwner(node, account);
  const endGuardians = await readGuardianState(node, account);
  record.balancesAfter = await balances();
  note('L9 end state', {
    owner: end.owner,
    validatorInitialized: endGuardians.validatorInitialized,
    validationInstalled: endGuardians.validationInstalled,
    recoveryRouted: endGuardians.recoveryRouted,
    recoveryAllowed: endGuardians.recoveryAllowed,
    balances: record.balancesAfter,
  });
  if (end.owner.toLowerCase() !== owner.address.toLowerCase() || endGuardians.validatorInitialized || endGuardians.validationInstalled || endGuardians.recoveryRouted || endGuardians.recoveryAllowed) {
    writeRecord(record);
    throw new Error('The account was not left as found');
  }
  writeRecord(record);
  console.log('\nINHERITANCE SMOKE PASSED');
}

function writeRecord(record) {
  const dir = new URL('./runs/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`inheritance-${record.startedAt.replace(/[:.]/g, '-')}.json`, dir);
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`Run record written to scripts/testnet/runs/${file.pathname.split('/').pop()}`);
}

async function cleanup(stage, { account, owner, newOwner, rootSpec, client, send }) {
  if (stage === 'clean') return;
  try {
    const current = (await readKernelOwner(node, account)).owner.toLowerCase();
    const g = await readGuardianState(node, account);
    const calls = [];
    if (current === newOwner.address.toLowerCase()) calls.push(...ownerRotationCalls(owner.address, { account }));
    if (g.validationInstalled || g.validatorInitialized || g.recoveryRouted) calls.push(...guardianUninstallCalls(account));
    if (calls.length === 0) return;
    const signer = current === newOwner.address.toLowerCase() ? newOwner : owner;
    const spec = current === newOwner.address.toLowerCase() ? kernelRecoveredAccountSpec({ node, account }) : rootSpec;
    await send(`CLEANUP signed by ${signer.address}`, client(spec), signer, calls);
  } catch (cleanupError) {
    console.log(`CLEANUP FAILED: ${maskSecrets(cleanupError.message)} — inspect ${account} manually`);
  }
}

(LIVE ? liveRun() : dryRun()).catch((error) => {
  console.error(`Inheritance smoke failed: ${maskSecrets(error.message)}`);
  process.exit(1);
});

/**
 * Spending-limit smoke test on Sepolia (phase 11, item 1): what ZeroDev's
 * SpendingLimit hook actually does on a Kernel v3.3 account, and what the
 * session permission policies do NOT do. Driven only by engine code
 * (packages/chains-evm/src/kernel-spending.ts, kernel-permissions.ts).
 *
 * DRY RUN ONLY. Nothing is signed for broadcast and nothing is sent: every
 * operation is signed locally and executed through EntryPoint v0.7
 * handleOps inside ONE read-only eth_simulateV1 request per part, whose
 * consecutive simulated blocks carry state forward, against the real
 * deployed EntryPoint, Kernel v3.3, ECDSA validator, SpendingLimit hook and
 * permission modules. There is deliberately no live mode: the deployed hook
 * makes every hooked UserOperation of a Kernel v3.3 account revert (see
 * part A), so installing it for real would lock the account's UserOperations
 * until the owner EOA removed it with a direct transaction.
 *
 * Part A — ZeroDev SpendingLimit hook 0xb6D6…D70E on the ROOT validation
 * (limit: 1,000 wei of native ETH):
 *   A0 control: a plain root op sending 1 wei works;
 *   A1 a root op clears the ECDSA validator's owner and re-installs the root
 *      validator with the hook, same owner (rootSpendingLimitInstallCalls) —
 *      accepted;
 *   A2 read-back: hook list + root validation hook;
 *   A3 a root op WITHOUT the executeUserOp prefix — rejected in validation
 *      (Kernel requires the prefix once the validation has a hook);
 *   A4 a hooked root op within the limit (1 wei) — expected to FAIL in
 *      execution: Kernel v3.3 calls postCheck(bytes), the hook only has
 *      postCheck(bytes,bool,bytes);
 *   A5 a hooked root op over the limit (5,000 wei) — fails the same way;
 *   A6 attribution: preCheck as Kernel v3.3 calls it succeeds, postCheck(bytes)
 *      reverts with empty data; then the hook's own rule, called the way Kernel v3.0 called it
 *      (postCheck(bytes,bool,bytes) from the account): 600 wei used against
 *      1,000 passes, a second 600 wei reverts ExceedsAllowance — the
 *      cumulative, lifetime (no window) rule is real, just unreachable from
 *      Kernel v3.3;
 *   A7 the owner EOA calls the account DIRECTLY (execute, 5,000 wei): accepted
 *      despite the hook — a root-validation hook never binds the owner;
 *   A8 the owner EOA removes the hook directly (uninstallModule(4, hook));
 *   A9 a plain root op works again; A10 read-back.
 *
 * Part B — session permission (CallPolicy cap 1 wei per call to the owner
 * EOA, TimestampPolicy 10 min), installed explicitly by a root op:
 *   B1 install; B2 a session op batching THREE 1-wei calls is accepted
 *   (3 wei moved under a "1 wei" cap: the cap is per call, not cumulative);
 *   B3 a single 2-wei call is rejected (CallViolatesValueRule).
 *
 * Account: by default the dev seed's Kernel account index 2
 * (0x1D723b78e1D0D84Fd0531e2686285fb1B6414106; the mnemonic is read from the
 * git-ignored .dev-wallet/mnemonic.txt and never printed). With
 * SPENDING_SMOKE_PUBLIC=1 (or without the dev mnemonic) the PUBLIC BIP-39
 * test mnemonic's undeployed account is used and deployed in the first
 * simulated block. Balances are state overrides; no funds are needed.
 *
 * Environment:
 *   SPENDING_SMOKE_DRY_RUN  must be unset or 1 (there is no live mode).
 *   SPENDING_SMOKE_PUBLIC   1 = public test mnemonic.
 *   NODE_URL                optional; defaults to the public Sepolia RPC.
 *
 * Run from the repository root after `npm run build`:
 *   node scripts/testnet/spending-limit-smoke.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  HOOK_POSTCHECK_KERNEL_V3_0,
  HOOK_POSTCHECK_KERNEL_V3_1,
  KERNEL_HOOK_NONE,
  SPENDING_LIMIT_NATIVE_TOKEN,
  SpendingLimitHookIncompatibleError,
  ZERODEV_SPENDING_LIMIT_HOOK,
  assessHookInterface,
  checkSpendingAgainstHook,
  createKernelAccountSpec,
  createSessionKeyAccount,
  encodeFunctionCall,
  encodeKernelExecute,
  encodePermissionInstall,
  rootSpendingLimitInstallCalls,
  encodeSequence,
  encodeSpendingLimitHookRemoval,
  generateSessionPrivateKey,
  getUserOpHash,
  httpTransport,
  kernelHookedCallData,
  kernelSessionSpec,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  prepareRootSpendingLimitInstall,
  readKernelOwner,
  readKernelPermissionState,
  toBytes,
  toHex,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

if (process.env.SPENDING_SMOKE_DRY_RUN !== undefined && process.env.SPENDING_SMOKE_DRY_RUN !== '1') {
  console.error(
    'There is no live mode: the deployed SpendingLimit hook would make every hooked UserOperation of a Kernel v3.3 ' +
      'account revert. Run without SPENDING_SMOKE_DRY_RUN or with SPENDING_SMOKE_DRY_RUN=1.',
  );
  process.exit(1);
}

const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const DEV_MNEMONIC_FILE = new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);
const USE_PUBLIC = process.env.SPENDING_SMOKE_PUBLIC === '1' || !existsSync(DEV_MNEMONIC_FILE);
const INDEX = USE_PUBLIC ? 0n : 2n;
const EXPECTED_DEV_ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN_ID = 11155111n;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const LIMIT_WEI = 1000n;
const ONE_ETH_HEX = '0xde0b6b3a7640000';

const node = httpTransport(NODE_URL);
const topic = (sig) => toHex(keccak_256(utf8ToBytes(sig)));
const errorSelector = (sig) => topic(sig).slice(0, 10);
const USER_OPERATION_EVENT = topic('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
const USER_OPERATION_REVERT_REASON = topic('UserOperationRevertReason(bytes32,address,uint256,bytes)');
const KNOWN_ERRORS = Object.fromEntries(
  [
    'FailedOp(uint256,string)',
    'FailedOpWithRevert(uint256,string,bytes)',
    'OnlyExecuteUserOp()',
    'ExecutionReverted()',
    'ExceedsAllowance()',
    'InvalidCaller()',
    'InvalidValidator()',
    'CallViolatesParamRule()',
    'CallViolatesValueRule()',
    'InvalidCallData()',
  ].map((s) => [errorSelector(s), s]),
);

function describeRevert(data) {
  if (typeof data !== 'string' || data === '0x' || data.length < 10) return `revert without data (${data ?? 'none'})`;
  const sel = data.slice(0, 10).toLowerCase();
  const name = KNOWN_ERRORS[sel];
  if (!name) return `revert ${sel} (unknown selector)`;
  if (!name.startsWith('FailedOp')) return name;
  const body = data.slice(10);
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  const strOffset = Number(BigInt('0x' + word(1))) / 32;
  const strLen = Number(BigInt('0x' + word(strOffset)));
  const reason = Buffer.from(body.slice((strOffset + 1) * 64, (strOffset + 1) * 64 + strLen * 2), 'hex').toString();
  let inner = '';
  if (name.startsWith('FailedOpWithRevert')) {
    const bOffset = Number(BigInt('0x' + word(2))) / 32;
    const bLen = Number(BigInt('0x' + word(bOffset)));
    const innerData = '0x' + body.slice((bOffset + 1) * 64, (bOffset + 1) * 64 + bLen * 2);
    inner = innerData === '0x' ? ' -> inner revert without data' : ` -> inner ${KNOWN_ERRORS[innerData.slice(0, 10).toLowerCase()] ?? innerData.slice(0, 10)}`;
  }
  return `${name.split('(')[0]}("${reason}")${inner}`;
}

const HANDLE_OPS_SIG = 'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';
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

/** UserOperationEvent success flag and UserOperationRevertReason bytes for one op, from simulated logs. */
function opOutcome(logs, userOpHash) {
  let success = null;
  let revertReason = null;
  for (const log of logs ?? []) {
    if (log.topics?.[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    const t0 = log.topics[0]?.toLowerCase();
    if (t0 === USER_OPERATION_EVENT) success = BigInt('0x' + log.data.slice(2 + 64, 2 + 128)) === 1n;
    if (t0 === USER_OPERATION_REVERT_REASON) {
      const body = log.data.slice(2);
      const off = Number(BigInt('0x' + body.slice(64, 128))) * 2;
      const len = Number(BigInt('0x' + body.slice(off, off + 64)));
      revertReason = '0x' + body.slice(off + 64, off + 64 + len * 2);
    }
  }
  return { success, revertReason };
}

function loadOwner(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');
}

async function rootNonce(account) {
  return BigInt(
    await node('eth_call', [
      {
        to: ENTRYPOINT_V07,
        data: toHex(
          encodeFunctionCall('getNonce(address,uint192)', [
            { kind: 'address', value: account },
            { kind: 'uint256', value: 0n },
          ]),
        ),
      },
      'latest',
    ]),
  );
}

const GAS = {
  callGasLimit: 600_000n,
  verificationGasLimit: 1_500_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

function signOp(op, signer, spec) {
  return { ...op, signature: spec.signUserOpHash(signer, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) };
}

const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + i * 64 + 64));
const addrWord = (hex, i) => '0x' + hex.slice(2 + i * 64 + 24, 2 + i * 64 + 64);

async function main() {
  const owner = loadOwner(USE_PUBLIC ? PUBLIC_TEST_MNEMONIC : readFileSync(DEV_MNEMONIC_FILE, 'utf8').trim());
  const chainId = BigInt(await node('eth_chainId', []));
  if (chainId !== CHAIN_ID) throw new Error(`Not Sepolia: chain id ${chainId}`);
  await verifyKernelDeployment(node);
  const rootSpec = createKernelAccountSpec({ node, index: INDEX });
  const account = await rootSpec.getAddress(owner);
  const code = await node('eth_getCode', [account, 'latest']);
  const deployed = code !== '0x';
  console.log(
    `DRY RUN (${USE_PUBLIC ? 'public test mnemonic' : 'dev seed'}). Owner EOA ${owner.address}; ` +
      `Kernel account index ${INDEX} ${account} (deployed: ${deployed})`,
  );
  if (!USE_PUBLIC && account.toLowerCase() !== EXPECTED_DEV_ACCOUNT.toLowerCase()) {
    throw new Error(`Account ${account} is not the expected ${EXPECTED_DEV_ACCOUNT}`);
  }
  if (deployed) {
    const ownerState = await readKernelOwner(node, account);
    if (!ownerState.ecdsaRoot || ownerState.owner.toLowerCase() !== owner.address.toLowerCase()) {
      throw new Error(`Root validator/owner mismatch: ${JSON.stringify(ownerState)}`);
    }
    console.log(`Root validator ${ownerState.rootValidator}, stored owner ${ownerState.owner} (matches)`);
  }

  // --- Engine checks before any simulation -------------------------------
  const hook = ZERODEV_SPENDING_LIMIT_HOOK.address;
  const assessment = await assessHookInterface(node, hook);
  console.log('\nEngine assessment of the deployed hook (read-only):');
  console.log(
    `  code keccak ${assessment.codeKeccak} (pinned: ${assessment.isZeroDevSpendingLimit}); ` +
      `postCheck(bytes) ${HOOK_POSTCHECK_KERNEL_V3_1} present: ${assessment.implementsKernelV31PostCheck}; ` +
      `postCheck(bytes,bool,bytes) ${HOOK_POSTCHECK_KERNEL_V3_0} present: ${assessment.implementsKernelV30PostCheck}; ` +
      `compatible with Kernel v3.3: ${assessment.compatibleWithKernelV3_3}`,
  );
  const limits = [{ token: SPENDING_LIMIT_NATIVE_TOKEN, allowance: LIMIT_WEI }];
  if (deployed) {
    try {
      await prepareRootSpendingLimitInstall(node, { account, owner: owner.address, limits });
      throw new Error('prepareRootSpendingLimitInstall unexpectedly accepted the incompatible hook');
    } catch (error) {
      if (!(error instanceof SpendingLimitHookIncompatibleError)) throw error;
      console.log(`  prepareRootSpendingLimitInstall refuses: ${error.message}`);
    }
  }
  for (const [label, delta] of [
    ['1 wei', -1n],
    ['5,000 wei', -5000n],
  ]) {
    const r = checkSpendingAgainstHook(limits, [{ token: SPENDING_LIMIT_NATIVE_TOKEN, delta }]);
    console.log(`  local mirror of the hook rule, ${label} out against ${LIMIT_WEI} wei: exceeds=${r.exceeds}`);
  }

  // --- Part A --------------------------------------------------------------
  const from = owner.address;
  let nonce = deployed ? await rootNonce(account) : 0n;
  const factoryArgs = deployed ? {} : await rootSpec.getFactoryArgs(owner);
  const rootOp = (callData, extra = {}) => {
    const op = signOp({ sender: account, nonce, callData, ...GAS, ...extra }, owner, rootSpec);
    return op;
  };
  const send = (to, value) => encodeKernelExecute([{ to, value, data: new Uint8Array(0) }]);
  const viaEntryPoint = (op) => ({ from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' });
  const plainCall = (to, data, callFrom = from) => ({ from: callFrom, to, data: toHex(data), gas: '0x989680' });

  const steps = [];
  const addOp = (name, op, expect, accepted) => {
    steps.push({ name, kind: 'op', op, expect, call: viaEntryPoint(op) });
    if (accepted) nonce += 1n;
  };
  // A0 (with deployment when needed)
  addOp('A0 control: plain root op, 1 wei to the owner EOA', rootOp(send(owner.address, 1n), factoryArgs), 'success', true);
  // A1 install
  addOp('A1 root op: clear + re-install the ECDSA root validator WITH the SpendingLimit hook (limit 1,000 wei ETH)',
    rootOp(encodeKernelExecute(rootSpendingLimitInstallCalls(account, owner.address, limits))), 'success', true);
  // A2 read-back
  const rootVid = new Uint8Array(21);
  rootVid[0] = 0x01;
  rootVid.set(toBytes('0x845ADb2C711129d4f3966735eD98a9F09fC4cE57'), 1);
  steps.push({ name: 'A2 read: hook.listLength(account)', kind: 'read', key: 'len', call: plainCall(hook, encodeFunctionCall('listLength(address)', [{ kind: 'address', value: account }])) });
  steps.push({ name: 'A2 read: hook.spendingLimit(0, account)', kind: 'read', key: 'limit0', call: plainCall(hook, encodeFunctionCall('spendingLimit(uint256,address)', [{ kind: 'uint256', value: 0n }, { kind: 'address', value: account }])) });
  steps.push({ name: 'A2 read: account.validationConfig(root)', kind: 'read', key: 'rootCfg', call: plainCall(account, encodeFunctionCall('validationConfig(bytes21)', [{ kind: 'fixedBytes', value: rootVid }])) });
  // A3 no prefix
  addOp('A3 root op WITHOUT the executeUserOp prefix (1 wei)', rootOp(send(owner.address, 1n)), 'rejected', false);
  // A4 / A5 hooked
  addOp('A4 hooked root op WITHIN the limit (1 wei)', rootOp(kernelHookedCallData(send(owner.address, 1n))), 'executionFailed', true);
  addOp('A5 hooked root op OVER the limit (5,000 wei)', rootOp(kernelHookedCallData(send(DEAD, 5000n))), 'executionFailed', true);
  // A6 the hook's own rule, three-argument postCheck called from the account with an exact balance override.
  const B = 10n ** 18n;
  const ctx = (pre) => encodeSequence([{ kind: 'array', items: [{ kind: 'uint256', value: pre }] }]);
  const postCheck3 = (pre) =>
    encodeFunctionCall('postCheck(bytes,bool,bytes)', [
      { kind: 'bytes', value: ctx(pre) },
      { kind: 'uint256', value: 1n },
      { kind: 'bytes', value: new Uint8Array(0) },
    ]);
  const postCheck1 = (pre) => encodeFunctionCall('postCheck(bytes)', [{ kind: 'bytes', value: ctx(pre) }]);
  const preCheck = encodeFunctionCall('preCheck(address,uint256,bytes)', [
    { kind: 'address', value: ENTRYPOINT_V07 },
    { kind: 'uint256', value: 0n },
    { kind: 'bytes', value: send(owner.address, 1n) },
  ]);
  steps.push({ name: 'A6p preCheck(address,uint256,bytes) from the account (as v3.3 calls it)', kind: 'call', expect: 'success', call: plainCall(hook, preCheck, account) });
  steps.push({ name: 'A6a Kernel v3.3-style postCheck(bytes) from the account (as v3.3 calls it)', kind: 'call', expect: 'revert', balance: B, call: plainCall(hook, postCheck1(B + 600n), account) });
  steps.push({ name: 'A6b Kernel v3.0-style postCheck(bytes,bool,bytes): 600 wei used of 1,000', kind: 'call', expect: 'success', balance: B, call: plainCall(hook, postCheck3(B + 600n), account) });
  steps.push({ name: 'A6c same again: 600 wei more, only 400 left', kind: 'call', expect: 'revert', balance: B, call: plainCall(hook, postCheck3(B + 600n), account) });
  steps.push({ name: 'A6 read: hook.spendingLimit(0, account) after A6b', kind: 'read', key: 'limitAfterA6', call: plainCall(hook, encodeFunctionCall('spendingLimit(uint256,address)', [{ kind: 'uint256', value: 0n }, { kind: 'address', value: account }])) });
  // A7 / A8 direct owner EOA calls
  steps.push({ name: 'A7 owner EOA calls account.execute DIRECTLY: 5,000 wei to 0x…dEaD (limit 1,000)', kind: 'call', expect: 'success', call: plainCall(account, send(DEAD, 5000n)) });
  steps.push({ name: 'A8 owner EOA calls account.uninstallModule(4, hook) DIRECTLY', kind: 'call', expect: 'success', call: plainCall(account, encodeSpendingLimitHookRemoval(hook)) });
  // A9 / A10
  addOp('A9 plain root op after removal (1 wei)', rootOp(send(owner.address, 1n)), 'success', true);
  steps.push({ name: 'A10 read: account.validationConfig(root)', kind: 'read', key: 'rootCfgAfter', call: plainCall(account, encodeFunctionCall('validationConfig(bytes21)', [{ kind: 'fixedBytes', value: rootVid }])) });
  steps.push({ name: 'A10 read: hook.listLength(account)', kind: 'read', key: 'lenAfter', call: plainCall(hook, encodeFunctionCall('listLength(address)', [{ kind: 'address', value: account }])) });

  const blockStateCalls = steps.map((step, i) => {
    const overrides = {};
    if (i === 0) {
      overrides[account] = { balance: ONE_ETH_HEX };
      overrides[from] = { balance: ONE_ETH_HEX };
    }
    if (step.balance !== undefined) overrides[account] = { balance: '0x' + step.balance.toString(16) };
    return { ...(Object.keys(overrides).length ? { stateOverrides: overrides } : {}), calls: [step.call] };
  });
  console.log(`\nPart A: ${steps.length} simulated blocks in one eth_simulateV1 request against Sepolia "latest"`);
  const resultA = await node('eth_simulateV1', [{ blockStateCalls }, 'latest']);
  let failed = false;
  const reads = {};
  steps.forEach((step, i) => {
    const call = resultA[i].calls[0];
    if (step.kind === 'read') {
      if (call.status !== '0x1') {
        failed = true;
        console.log(`FAIL ${step.name}: reverted`);
        return;
      }
      reads[step.key] = call.returnData;
      return;
    }
    if (step.kind === 'call') {
      const ok = call.status === '0x1';
      const pass = ok === (step.expect === 'success');
      if (!pass) failed = true;
      const detail = ok ? 'success' : describeRevert(call.error?.data ?? call.returnData);
      console.log(`${pass ? 'PASS' : 'FAIL'} ${step.name}: ${detail}`);
      return;
    }
    const hash = toHex(getUserOpHash(step.op, ENTRYPOINT_V07, CHAIN_ID));
    let outcome;
    let detail;
    if (call.status !== '0x1') {
      outcome = 'rejected';
      detail = describeRevert(call.error?.data ?? call.returnData);
    } else {
      const { success, revertReason } = opOutcome(call.logs, hash);
      outcome = success === true ? 'success' : success === false ? 'executionFailed' : 'unknown';
      detail =
        success === true
          ? 'UserOperationEvent success=true'
          : `UserOperationEvent success=${success}; UserOperationRevertReason ${revertReason === null ? 'absent = the account reverted with EMPTY data (EntryPoint v0.7 emits the event only for non-empty data), as a call to a missing function does' : describeRevert(revertReason)}`;
    }
    const pass = outcome === step.expect;
    if (!pass) failed = true;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${step.name}: ${outcome} (${detail})`);
    if (step.name.startsWith('A2') || step.name.startsWith('A1')) return;
  });
  const show = (k, f) => (reads[k] ? f(reads[k]) : 'n/a');
  console.log(
    `  read-back after A1: listLength=${show('len', (h) => word(h, 0))}, entry0 token=${show('limit0', (h) => addrWord(h, 0))} ` +
      `allowance=${show('limit0', (h) => word(h, 1))}, root validation hook=${show('rootCfg', (h) => addrWord(h, 1))}`,
  );
  console.log(`  read-back after A6b: allowance=${show('limitAfterA6', (h) => word(h, 1))} (1,000 - 600)`);
  console.log(
    `  read-back after A8: root validation hook=${show('rootCfgAfter', (h) => addrWord(h, 1))} ` +
      `(${KERNEL_HOOK_NONE} = none), listLength=${show('lenAfter', (h) => word(h, 0))}`,
  );
  const checks = [
    [reads.len && word(reads.len, 0) === 1n, 'hook list length 1 after install'],
    [reads.limit0 && word(reads.limit0, 1) === LIMIT_WEI, 'allowance 1,000 after install'],
    [reads.rootCfg && addrWord(reads.rootCfg, 1).toLowerCase() === hook.toLowerCase(), 'root validation hook = SpendingLimit'],
    [reads.limitAfterA6 && word(reads.limitAfterA6, 1) === LIMIT_WEI - 600n, 'allowance 400 after A6b'],
    [reads.rootCfgAfter && addrWord(reads.rootCfgAfter, 1).toLowerCase() === KERNEL_HOOK_NONE.toLowerCase(), 'root hook none after A8'],
    [reads.lenAfter && word(reads.lenAfter, 0) === 0n, 'hook list cleared after A8'],
  ];
  for (const [ok, label] of checks) {
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} read-back: ${label}`);
  }

  // --- Part B --------------------------------------------------------------
  // A fresh simulation from "latest": install a 1-wei-per-call session, then batch.
  console.log('\nPart B: session permission with CallPolicy (1 wei per call) — separate eth_simulateV1 request');
  nonce = deployed ? await rootNonce(account) : 0n;
  const stepsB = [];
  if (!deployed) {
    stepsB.push({ name: 'B0 deploy (public account)', op: rootOp(send(owner.address, 0n), factoryArgs), expect: 'success' });
    nonce += 1n;
  }
  const latest = await node('eth_getBlockByNumber', ['latest', false]);
  const now = Number(BigInt(latest.timestamp));
  const sessionKey = createSessionKeyAccount(generateSessionPrivateKey());
  const grant = {
    sessionKey: sessionKey.address,
    calls: [{ target: owner.address, selector: null, valueLimit: 1n }],
    validAfter: 0,
    validUntil: now + 600,
  };
  let currentNonce = 1;
  let validationNonce = 0;
  if (deployed) {
    const state = await readKernelPermissionState(node, account, new Uint8Array(4));
    currentNonce = state.currentNonce;
  }
  const inst = encodePermissionInstall(grant, { chainId: CHAIN_ID, account, currentNonce, validationNonce, now });
  if (deployed) {
    const state = await readKernelPermissionState(node, account, inst.permissionId);
    if (state.installed) throw new Error('Fresh permission id unexpectedly installed');
    if (state.validationNonce !== 0) validationNonce = state.validationNonce;
  }
  stepsB.push({ name: 'B1 root op: explicit install of the session permission', op: rootOp(encodeKernelExecute(inst.installCalls)), expect: 'success' });
  nonce += 1n;
  const sessionSpec = kernelSessionSpec({ account, sessionKey: sessionKey.address, permissionId: inst.permissionId });
  const sessionOp = (calls, seq) =>
    signOp({ sender: account, nonce: (sessionSpec.nonceKey << 64n) + seq, callData: sessionSpec.encodeCalls(calls), ...GAS }, sessionKey, sessionSpec);
  const oneWei = { to: owner.address, value: 1n, data: new Uint8Array(0) };
  stepsB.push({ name: 'B2 session op: BATCH of three 1-wei calls (3 wei total, "cap" 1 wei)', op: sessionOp([oneWei, oneWei, oneWei], 0n), expect: 'success' });
  stepsB.push({ name: 'B3 session op: single 2-wei call', op: sessionOp([{ ...oneWei, value: 2n }], 1n), expect: 'rejected' });
  const resultB = await node('eth_simulateV1', [
    {
      blockStateCalls: stepsB.map((s, i) => ({
        ...(i === 0 ? { stateOverrides: { [account]: { balance: ONE_ETH_HEX }, [from]: { balance: ONE_ETH_HEX } } } : {}),
        calls: [viaEntryPoint(s.op)],
      })),
    },
    'latest',
  ]);
  stepsB.forEach((s, i) => {
    const call = resultB[i].calls[0];
    const hash = toHex(getUserOpHash(s.op, ENTRYPOINT_V07, CHAIN_ID));
    let outcome;
    let detail;
    if (call.status !== '0x1') {
      outcome = 'rejected';
      detail = describeRevert(call.error?.data ?? call.returnData);
    } else {
      const { success } = opOutcome(call.logs, hash);
      outcome = success === true ? 'success' : 'executionFailed';
      detail = `UserOperationEvent success=${success}`;
    }
    const pass = outcome === s.expect;
    if (!pass) failed = true;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${s.name}: ${outcome} (${detail})`);
  });

  if (failed) throw new Error('Dry run expectations not met');
  console.log('\nDRY RUN PASSED. Findings proven against the real Sepolia contracts (nothing was broadcast):');
  console.log(' - ZeroDev SpendingLimit installs on the Kernel v3.3 root validation, but EVERY hooked operation then fails');
  console.log('   in execution (within or over the limit alike), because Kernel v3.3 calls postCheck(bytes), which the');
  console.log('   hook does not implement; its own cumulative rule works only through the Kernel v3.0 postCheck.');
  console.log(' - The owner EOA bypasses a root-validation hook with a direct call and can remove it at once.');
  console.log(' - A CallPolicy value cap is per call: a batch moves several caps in one session operation.');
}

main().catch((error) => {
  console.error(`Spending-limit smoke failed: ${error.message}`);
  process.exit(1);
});

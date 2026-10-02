/**
 * Session-key smoke test on Sepolia (phase 8, item 2): Kernel v3.3
 * permission validation with ZeroDev's ECDSASigner, CallPolicy v0.0.4 and
 * TimestampPolicy, driven only by engine code
 * (packages/chains-evm/src/kernel-permissions.ts).
 *
 * LIVE flow, on an ALREADY-DEPLOYED Kernel account owned by the dev seed EOA:
 *   1. generate a fresh random session key (only its address is printed);
 *   2. grant it a call policy allowing ONLY (a) a zero-value, empty-calldata
 *      call to the account itself and (b) a call of at most 1 wei with empty
 *      calldata to the owner EOA, valid for 10 minutes (TimestampPolicy);
 *   3. the root owner signs the EIP-712 "Enable" payload; the SESSION key
 *      signs ONE UserOperation (enable mode) that installs the permission and
 *      executes both allowed calls, through the bundler;
 *   4. prove that disallowed calls (another target; 2 wei) are rejected at
 *      the bundler's estimation, and decode the on-chain reason from a
 *      read-only EntryPoint.handleOps simulation of a session-signed op;
 *   5. revoke the permission with a ROOT-signed uninstallValidation op;
 *   6. prove the session key can no longer act (default mode), and that the
 *      original enable signature cannot reinstall it.
 * Every operation sent is first simulated through EntryPoint v0.7 handleOps
 * with eth_call; negative tests use a bundler wrapper that refuses
 * eth_sendUserOperation, so a negative test can never broadcast. If anything
 * fails after the permission was installed, the script revokes it before
 * exiting so the account is left clean.
 *
 * DRY RUN (SESSION_SMOKE_DRY_RUN=1): no keys from .dev-wallet, no bundler,
 * nothing broadcast. Uses the PUBLIC BIP-39 test mnemonic's Kernel account
 * (undeployed on Sepolia) and one read-only eth_simulateV1 request whose
 * consecutive simulated blocks deploy it (root op with initCode), install the
 * session in enable mode, try a disallowed call, revoke, and try again.
 *
 * Environment:
 *   ZERODEV_PROJECT_ID  live only; bundler URL
 *                       https://rpc.zerodev.app/api/v3/{id}/chain/11155111
 *                       (docs.zerodev.app/meta-infra/rpcs). Never printed.
 *   BUNDLER_URL         optional override of the bundler URL. Never printed.
 *   NODE_URL            optional; defaults to the public Sepolia RPC.
 *   KERNEL_INDEX        optional; default 2 (the dev seed's account
 *                       0x1D723b78e1D0D84Fd0531e2686285fb1B6414106).
 *   EXPECTED_ACCOUNT    optional; default that address for index 2. The live
 *                       run refuses to continue if the account differs.
 *
 * Run from the repository root after `npm run build`:
 *   Live:    set -a; . .dev-wallet/env; set +a; node scripts/testnet/session-key-smoke.mjs
 *   Dry run: SESSION_SMOKE_DRY_RUN=1 node scripts/testnet/session-key-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  NodeClient,
  SmartAccountClient,
  assertCallsAllowed,
  createKernelAccountSpec,
  createSessionKeyAccount,
  encodeFunctionCall,
  encodeKernelExecute,
  encodePermissionInstall,
  generateSessionPrivateKey,
  getUserOpHash,
  httpTransport,
  kernelSessionSpec,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  permissionRevokeCall,
  prepareKernelPermissionInstall,
  readKernelPermissionState,
  readSessionSigner,
  signPermissionEnable,
  toBytes,
  toHex,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const DRY_RUN = process.env.SESSION_SMOKE_DRY_RUN === '1';
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const INDEX = BigInt(process.env.KERNEL_INDEX ?? (DRY_RUN ? '0' : '2'));
const EXPECTED_ACCOUNT =
  process.env.EXPECTED_ACCOUNT ?? (INDEX === 2n && !DRY_RUN ? '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106' : '');
const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID
    ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/11155111`
    : undefined);
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN_ID = 11155111n;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const SESSION_SECONDS = 600;

if (!DRY_RUN && !BUNDLER_URL) {
  console.error('Set ZERODEV_PROJECT_ID (or BUNDLER_URL), or SESSION_SMOKE_DRY_RUN=1 for a read-only dry run.');
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
    // CallPolicy v0.0.4 (Sourcify-verified source).
    'InvalidCallType()',
    'InvalidCallData()',
    'CallViolatesParamRule()',
    'CallViolatesValueRule()',
    // Kernel v3.3 ValidationManager / Kernel.
    'InvalidValidator()',
    'InvalidNonce()',
    'EnableNotApproved()',
    'PolicyFailed(uint256)',
    'SignerPrefixNotPresent()',
    'PermissionNotAlllowedForUserOp()',
    'InvalidValidationType()',
  ].map((s) => [errorSelector(s), s]),
);

/** Best-effort decoding of an EntryPoint revert (FailedOp / FailedOpWithRevert and the inner error). */
function describeRevert(data) {
  if (typeof data !== 'string' || data.length < 10) return `revert data ${data}`;
  const sel = data.slice(0, 10).toLowerCase();
  const name = KNOWN_ERRORS[sel];
  if (!name) return `revert ${sel} (unknown selector)`;
  if (name.startsWith('FailedOp')) {
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
      inner =
        innerData === '0x'
          ? ' -> inner revert without data (e.g. a call to a cleared module address)'
          : ` -> inner ${KNOWN_ERRORS[innerData.slice(0, 10).toLowerCase()] ?? innerData.slice(0, 10)}`;
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

/** Extracts revert data from a JSON-RPC error message or object, if present. */
function revertDataOf(error) {
  const match = /(0x[0-9a-fA-F]{8,})/.exec(String(error?.message ?? error));
  return match ? match[1] : null;
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

function loadOwner(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');
}

async function latestTimestamp() {
  const block = await node('eth_getBlockByNumber', ['latest', false]);
  return Number(BigInt(block.timestamp));
}

function sessionGrant(sessionAddress, account, ownerAddress, now) {
  return {
    sessionKey: sessionAddress,
    calls: [
      { target: account, selector: null, valueLimit: 0n },
      { target: ownerAddress, selector: null, valueLimit: 1n },
    ],
    validAfter: 0,
    validUntil: now + SESSION_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Dry run: one eth_simulateV1 request, five simulated blocks.
// ---------------------------------------------------------------------------

async function dryRun() {
  const owner = loadOwner(PUBLIC_TEST_MNEMONIC);
  const rootSpec = createKernelAccountSpec({ node, index: INDEX });
  const account = await rootSpec.getAddress(owner);
  const code = await node('eth_getCode', [account, 'latest']);
  console.log(`DRY RUN (public test mnemonic). Owner ${owner.address}; Kernel account ${account} (deployed: ${code !== '0x'})`);
  if (code !== '0x') throw new Error('The dry run expects the public-mnemonic Kernel account to be undeployed');

  const sessionKey = createSessionKeyAccount(generateSessionPrivateKey());
  console.log(`Fresh session key: ${sessionKey.address}`);
  const now = await latestTimestamp();
  const grant = sessionGrant(sessionKey.address, account, owner.address, now);
  // A freshly initialized Kernel has currentNonce 1 [Kernel.initialize] and the
  // permission's validation config is empty.
  const inst = encodePermissionInstall(grant, { chainId: CHAIN_ID, account, currentNonce: 1, validationNonce: 0, now });
  console.log(`Permission id ${toHex(inst.permissionId)}; enable nonce ${inst.enable.nonce}`);
  const enableSignature = signPermissionEnable(owner, inst.enable.digest);

  const gas = {
    callGasLimit: 400_000n,
    verificationGasLimit: 1_500_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };
  const sign = (op, signer, spec) => ({ ...op, signature: spec.signUserOpHash(signer, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) });
  const factory = await rootSpec.getFactoryArgs(owner);
  const ops = {};
  ops.deploy = sign(
    {
      sender: account,
      nonce: 0n,
      ...factory,
      callData: encodeKernelExecute([{ to: account, value: 0n, data: new Uint8Array(0) }]),
      ...gas,
    },
    owner,
    rootSpec,
  );
  const enableSpec = kernelSessionSpec({
    account,
    sessionKey: sessionKey.address,
    permissionId: inst.permissionId,
    enable: { validatorData: inst.validatorData, enableSignature },
  });
  const allowedCalls = [
    { to: account, value: 0n, data: new Uint8Array(0) },
    { to: owner.address, value: 1n, data: new Uint8Array(0) },
  ];
  ops.enable = sign(
    { sender: account, nonce: enableSpec.nonceKey << 64n, callData: enableSpec.encodeCalls(allowedCalls), ...gas },
    sessionKey,
    enableSpec,
  );
  const sessionSpec = kernelSessionSpec({ account, sessionKey: sessionKey.address, permissionId: inst.permissionId });
  ops.disallowedValue = sign(
    {
      sender: account,
      nonce: sessionSpec.nonceKey << 64n,
      callData: sessionSpec.encodeCalls([{ to: owner.address, value: 2n, data: new Uint8Array(0) }]),
      ...gas,
    },
    sessionKey,
    sessionSpec,
  );
  ops.disallowedTarget = sign(
    {
      sender: account,
      nonce: sessionSpec.nonceKey << 64n,
      callData: sessionSpec.encodeCalls([{ to: DEAD, value: 0n, data: new Uint8Array(0) }]),
      ...gas,
    },
    sessionKey,
    sessionSpec,
  );
  ops.revoke = sign(
    {
      sender: account,
      nonce: 1n,
      callData: encodeKernelExecute([permissionRevokeCall(account, inst.permissionId, inst.policyCount)]),
      ...gas,
    },
    owner,
    rootSpec,
  );
  ops.afterRevoke = sign(
    { sender: account, nonce: sessionSpec.nonceKey << 64n, callData: sessionSpec.encodeCalls([allowedCalls[0]]), ...gas },
    sessionKey,
    sessionSpec,
  );

  const from = owner.address;
  const callOf = (op) => ({ from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' });
  const order = ['deploy', 'enable', 'disallowedValue', 'disallowedTarget', 'revoke', 'afterRevoke'];
  const result = await node('eth_simulateV1', [
    {
      blockStateCalls: order.map((name, i) => ({
        ...(i === 0
          ? { stateOverrides: { [account]: { balance: '0xde0b6b3a7640000' }, [from]: { balance: '0xde0b6b3a7640000' } } }
          : {}),
        calls: [callOf(ops[name])],
      })),
    },
    'latest',
  ]);
  const expectations = {
    deploy: true,
    enable: true,
    disallowedValue: false,
    disallowedTarget: false,
    revoke: true,
    afterRevoke: false,
  };
  let failed = false;
  order.forEach((name, i) => {
    const call = result[i].calls[0];
    const hash = toHex(getUserOpHash(ops[name], ENTRYPOINT_V07, CHAIN_ID));
    const executed = call.status === '0x1' ? userOpEventSuccess(call.logs, hash) : null;
    const accepted = call.status === '0x1' && executed === true;
    const detail = call.status === '0x1' ? `UserOperationEvent success=${executed}` : describeRevert(call.error?.data ?? call.returnData);
    const ok = accepted === expectations[name];
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${accepted ? 'accepted' : 'rejected'} (${detail})`);
  });
  if (failed) throw new Error('Dry run expectations not met');
  console.log('\nDRY RUN PASSED: deployment, enable-mode session install + allowed calls, both disallowed');
  console.log('calls rejected, root revocation, and post-revocation rejection all behave as expected against');
  console.log('the real EntryPoint v0.7, Kernel v3.3 and ZeroDev permission modules on Sepolia. Nothing was broadcast.');
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

async function waitForReceipt(client, userOpHash) {
  const receipt = await client.waitForReceipt(userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
  const success = receipt?.success === true || receipt?.success === '0x1';
  const tx = receipt?.receipt?.transactionHash ?? '?';
  console.log(`  receipt: success=${success} bundle tx ${tx}`);
  if (!success) throw new Error(`UserOperation ${userOpHash} did not succeed`);
  return tx;
}

async function liveRun() {
  const owner = loadOwner(readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim());
  const chainId = await nodeClient.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`Not Sepolia: chain id ${chainId}`);
  await verifyKernelDeployment(node);
  const rootSpec = createKernelAccountSpec({ node, index: INDEX });
  const account = await rootSpec.getAddress(owner);
  console.log(`Owner EOA ${owner.address}; Kernel account (index ${INDEX}) ${account}`);
  if (EXPECTED_ACCOUNT && account.toLowerCase() !== EXPECTED_ACCOUNT.toLowerCase()) {
    throw new Error(`Account ${account} is not the expected ${EXPECTED_ACCOUNT}`);
  }
  const code = await node('eth_getCode', [account, 'latest']);
  if (!code || code === '0x') throw new Error('The live run needs an already-deployed Kernel account');
  const balance = await nodeClient.getBalance(account);
  console.log(`Account balance ${balance} wei`);

  const bundlerTransport = httpTransport(BUNDLER_URL);
  const bundlerCall = async (method, params) => {
    try {
      return await bundlerTransport(method, params);
    } catch (error) {
      throw new Error(maskSecrets(error.message));
    }
  };
  const entryPoints = await bundlerCall('eth_supportedEntryPoints', []);
  if (!entryPoints.map((a) => a.toLowerCase()).includes(ENTRYPOINT_V07.toLowerCase())) {
    throw new Error('Bundler does not support EntryPoint v0.7');
  }
  console.log(`Bundler: ${maskSecrets(BUNDLER_URL)} (EntryPoint v0.7 supported)`);

  // Fees: the larger of the node's suggestion and the bundler's own
  // pimlico_getUserOperationGasPrice "standard" tier (served by ZeroDev;
  // observed shape { slow, standard, fast } of { maxFeePerGas, maxPriorityFeePerGas }).
  const fees = await nodeClient.suggestFees();
  try {
    const price = await bundlerCall('pimlico_getUserOperationGasPrice', []);
    const standard = price?.standard;
    if (standard) {
      fees.maxFeePerGas = [fees.maxFeePerGas, BigInt(standard.maxFeePerGas)].reduce((a, b) => (a > b ? a : b));
      fees.maxPriorityFeePerGas = [fees.maxPriorityFeePerGas, BigInt(standard.maxPriorityFeePerGas)].reduce((a, b) =>
        a > b ? a : b,
      );
    }
  } catch {
    // Not served by this bundler: keep the node suggestion.
  }
  console.log(`Fees: maxFeePerGas ${fees.maxFeePerGas}, maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}`);

  // Bundler wrappers: `submitting` preflights through handleOps and submits;
  // `estimateOnly` refuses submission (for tests that must be rejected).
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
  const estimateOnly = async (method, params) => {
    if (method === 'eth_sendUserOperation') {
      lastSignedOp = fromRpc(params[0]);
      throw new Error('NEGATIVE TEST REACHED SUBMISSION (estimation accepted the operation)');
    }
    return bundlerCall(method, params);
  };
  const padding = { verification: 120, call: 130, preVerification: 105 };

  const sessionKey = createSessionKeyAccount(generateSessionPrivateKey());
  console.log(`Fresh session key (address only): ${sessionKey.address}`);
  const now = await latestTimestamp();
  const grant = sessionGrant(sessionKey.address, account, owner.address, now);
  console.log(
    `Grant: calls [account itself, 0 wei, empty calldata] and [${owner.address}, <= 1 wei, empty calldata]; ` +
      `validUntil ${grant.validUntil} (chain time ${now} + ${SESSION_SECONDS} s)`,
  );

  const inst = await prepareKernelPermissionInstall(node, grant, { chainId: CHAIN_ID, account, now });
  const permissionId = toHex(inst.permissionId);
  console.log(`Permission id ${permissionId}; validation id ${toHex(inst.validationId)}; enable nonce ${inst.enable.nonce}`);
  console.log(`Enable digest (root owner signs): ${toHex(inst.enable.digest)}`);
  const enableSignature = signPermissionEnable(owner, inst.enable.digest);

  let installed = false;
  const results = {};
  try {
    // 1. Session-signed enable-mode op: installs the permission and runs both allowed calls.
    const enableSpec = kernelSessionSpec({
      account,
      sessionKey: sessionKey.address,
      permissionId: inst.permissionId,
      grant,
      enable: { validatorData: inst.validatorData, enableSignature },
    });
    const enableClient = new SmartAccountClient({
      chainId: CHAIN_ID,
      entryPoint: ENTRYPOINT_V07,
      bundler: submitting,
      node: enableSpec.routeNode(node),
      spec: enableSpec,
      gasPaddingPct: padding,
    });
    const allowedCalls = [
      { to: account, value: 0n, data: new Uint8Array(0) },
      { to: owner.address, value: 1n, data: new Uint8Array(0) },
    ];
    console.log('\n[1] Session key sends ONE UserOperation in enable mode (installs + executes the allowed batch)');
    const { userOpHash } = await enableClient.sendCalls(sessionKey, allowedCalls, fees);
    installed = true; // accepted by the bundler: treat as installed for cleanup purposes
    console.log(`  accepted by bundler: userOpHash ${userOpHash}`);
    results.enableTx = await waitForReceipt(enableClient, userOpHash);
    results.enableUserOpHash = userOpHash;

    const state = await readKernelPermissionState(node, account, inst.permissionId);
    const storedSigner = await readSessionSigner(node, account, inst.permissionId);
    console.log(
      `  on-chain: installed=${state.installed} hook=${state.hook} signerModule=${state.signer} ` +
        `flag=0x${state.permissionFlag.toString(16).padStart(4, '0')} policies=[${state.policies.map((p) => p.policy).join(', ')}] ` +
        `executeAllowed=${state.executeAllowed} sessionSigner=${storedSigner}`,
    );
    if (!state.installed || storedSigner.toLowerCase() !== sessionKey.address.toLowerCase()) {
      throw new Error('Permission state after enable does not match the grant');
    }
    if (state.signer.toLowerCase() !== KERNEL_PERMISSION_MODULES.ecdsaSigner.toLowerCase()) {
      throw new Error('Unexpected signer module');
    }

    // 2. Disallowed calls must be rejected. No local grant check here, so the CONTRACTS decide.
    const rawSessionSpec = kernelSessionSpec({ account, sessionKey: sessionKey.address, permissionId: inst.permissionId });
    const negativeClient = new SmartAccountClient({
      chainId: CHAIN_ID,
      entryPoint: ENTRYPOINT_V07,
      bundler: estimateOnly,
      node: rawSessionSpec.routeNode(node),
      spec: rawSessionSpec,
      gasPaddingPct: padding,
    });
    const negatives = [
      ['different target (0 wei to 0x…dEaD)', [{ to: DEAD, value: 0n, data: new Uint8Array(0) }]],
      ['value above the cap (2 wei to the owner EOA)', [{ to: owner.address, value: 2n, data: new Uint8Array(0) }]],
    ];
    results.negatives = [];
    for (const [label, calls] of negatives) {
      console.log(`\n[2] Disallowed: ${label}`);
      try {
        assertCallsAllowed(grant, calls, await latestTimestamp());
        throw new Error('local check unexpectedly allowed the call');
      } catch (error) {
        console.log(`  engine refuses locally: ${error.message}`);
      }
      let rejection;
      try {
        await negativeClient.sendCalls(sessionKey, calls, fees);
        throw new Error('bundler unexpectedly returned a userOpHash');
      } catch (error) {
        if (/NEGATIVE TEST REACHED SUBMISSION|unexpectedly/.test(error.message)) throw error;
        rejection = error.message;
      }
      console.log(`  bundler estimation rejected it: ${maskSecrets(rejection)}`);
      // Same op, properly session-signed, simulated read-only for the exact on-chain reason.
      const op = await signedSessionOp(rawSessionSpec, sessionKey, account, calls, fees);
      const sim = await simulateHandleOps(op, owner.address);
      if (sim.ok) throw new Error('handleOps simulation unexpectedly accepted a disallowed call');
      console.log(`  EntryPoint.handleOps simulation (session-signed): ${sim.reason}`);
      results.negatives.push({ label, bundler: maskSecrets(rejection), onchain: sim.reason });
    }
  } catch (error) {
    if (installed) {
      console.log(`\nFailure after install (${maskSecrets(error.message)}); revoking to leave the account clean.`);
      try {
        await revoke(owner, rootSpec, account, inst, submitting, fees, padding);
      } catch (cleanupError) {
        console.log(`CLEANUP FAILED: ${maskSecrets(cleanupError.message)} — permission ${permissionId} may still be installed`);
      }
    }
    throw error;
  }

  // 3. Root-signed revocation.
  console.log('\n[3] Root owner revokes the permission (uninstallValidation, root-signed op)');
  const revoked = await revoke(owner, rootSpec, account, inst, submitting, fees, padding);
  results.revokeTx = revoked.tx;
  results.revokeUserOpHash = revoked.userOpHash;

  // 4. The session key can no longer act, and the old enable signature cannot reinstall it.
  const post = [];
  const rawSessionSpec = kernelSessionSpec({ account, sessionKey: sessionKey.address, permissionId: inst.permissionId });
  const replaySpec = kernelSessionSpec({
    account,
    sessionKey: sessionKey.address,
    permissionId: inst.permissionId,
    enable: { validatorData: inst.validatorData, enableSignature },
  });
  for (const [label, spec] of [
    ['previously allowed call after revocation (default mode)', rawSessionSpec],
    ['replay of the original enable signature (enable mode)', replaySpec],
  ]) {
    console.log(`\n[4] ${label}`);
    const client = new SmartAccountClient({
      chainId: CHAIN_ID,
      entryPoint: ENTRYPOINT_V07,
      bundler: estimateOnly,
      node: spec.routeNode(node),
      spec,
      gasPaddingPct: padding,
    });
    const calls = [{ to: account, value: 0n, data: new Uint8Array(0) }];
    let rejection;
    try {
      await client.sendCalls(sessionKey, calls, fees);
      throw new Error('bundler unexpectedly returned a userOpHash');
    } catch (error) {
      if (/NEGATIVE TEST REACHED SUBMISSION|unexpectedly/.test(error.message)) throw error;
      rejection = error.message;
    }
    console.log(`  bundler estimation rejected it: ${maskSecrets(rejection)}`);
    const op = await signedSessionOp(spec, sessionKey, account, calls, fees);
    const sim = await simulateHandleOps(op, owner.address);
    if (sim.ok) throw new Error('handleOps simulation unexpectedly accepted a revoked session');
    console.log(`  EntryPoint.handleOps simulation (session-signed): ${sim.reason}`);
    post.push({ label, bundler: maskSecrets(rejection), onchain: sim.reason });
  }

  console.log('\nSESSION KEY SMOKE PASSED');
  console.log(JSON.stringify({ account, sessionKey: sessionKey.address, permissionId, ...results, postRevocation: post }, null, 2));
}

/** A session-signed op with fixed generous gas, for read-only simulation only (never sent). */
async function signedSessionOp(spec, sessionKey, account, calls, fees) {
  const sequence = BigInt(
    await node('eth_call', [
      {
        to: ENTRYPOINT_V07,
        data: toHex(
          encodeFunctionCall('getNonce(address,uint192)', [
            { kind: 'address', value: account },
            { kind: 'uint256', value: spec.nonceKey },
          ]),
        ),
      },
      'latest',
    ]),
  );
  const op = {
    sender: account,
    nonce: sequence,
    callData: encodeKernelExecute(calls),
    callGasLimit: 300_000n,
    verificationGasLimit: 1_000_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: new Uint8Array(0),
  };
  return { ...op, signature: spec.signUserOpHash(sessionKey, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) };
}

async function revoke(owner, rootSpec, account, inst, bundler, fees, padding) {
  const client = new SmartAccountClient({
    chainId: CHAIN_ID,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec: rootSpec,
    gasPaddingPct: padding,
  });
  const { userOpHash } = await client.sendCalls(
    owner,
    [permissionRevokeCall(account, inst.permissionId, inst.policyCount)],
    fees,
  );
  console.log(`  accepted by bundler: userOpHash ${userOpHash}`);
  const tx = await waitForReceipt(client, userOpHash);
  const state = await readKernelPermissionState(node, account, inst.permissionId);
  const storedSigner = await readSessionSigner(node, account, inst.permissionId);
  console.log(
    `  on-chain after revoke: installed=${state.installed} hook=${state.hook} signerModule=${state.signer} ` +
      `policies=${state.policies.length} sessionSigner=${storedSigner}`,
  );
  if (state.installed || !/^0x0{40}$/i.test(state.hook)) throw new Error('Permission still installed after revoke');
  return { userOpHash, tx };
}

(DRY_RUN ? dryRun() : liveRun()).catch((error) => {
  console.error(`Session key smoke failed: ${maskSecrets(error.message)}`);
  process.exit(1);
});

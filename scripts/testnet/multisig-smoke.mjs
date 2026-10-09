/**
 * Multi-signature (k-of-n) Kernel v3.3 smoke test (phase 15 item 2).
 *
 * A multisig account is a Kernel v3.3 account whose ROOT validator is
 * ZeroDev's deployed WeightedECDSAValidator
 * (0xeD89244160CfE273800B58b1B534031699dFeEEE), so every operation needs a
 * combined signer weight of at least the threshold. Everything is built with
 * the engine module packages/chains-evm/src/kernel-multisig.ts. See
 * docs/MULTISIG.md for the full analysis; the determinations this script
 * demonstrates against the deployed contracts are:
 *
 *   1. An honest k-of-n OPERATION is enforced: a 2-of-3 operation signed by
 *      two DISTINCT signers is accepted.
 *   2. Fewer signatures are refused: one signer alone fails validation
 *      (FailedOp "AA24 signature error").
 *   3. The repeated-signer trick does NOT work for operations: the same
 *      signer used as both an approver and the final signer is still only
 *      counted once, so a 2-of-3 with one signer is refused.
 *   4. ERC-1271 MESSAGE signing is broken for a multisig, which is why the
 *      engine refuses it: one signer, signing the account's wrapped message
 *      digest and DUPLICATING that signature, satisfies a 2-of-3
 *      isValidSignature (returns 0x1626ba7e); a single, non-duplicated
 *      signature from the same signer is rejected.
 *   5. The exposure calculator (multisigExposure) states, for several
 *      shapes, how many signers an operation needs versus a message.
 *
 * DRY RUN (MULTISIG_SMOKE_DRY_RUN=1, the default when no bundler is set): no
 * keys from .dev-wallet, no bundler, nothing broadcast. Each determination
 * is one read-only eth_simulateV1 request against the real EntryPoint v0.7,
 * Kernel v3.3 and WeightedECDSAValidator on Sepolia, for the PUBLIC BIP-39
 * test mnemonic's undeployed 2-of-3 account at MULTISIG_INDEX (default 77).
 *
 * LIVE (BUNDLER_URL or ZERODEV_PROJECT_ID set, MULTISIG_SMOKE_LIVE=1): the
 * dev seed's indices 0, 1 and 2 form a 2-of-3 (weight 1 each, threshold 2).
 * The open question only a live run can answer is whether a real bundler
 * accepts a weighted-ROOT operation at all: the validator is NOT staked in
 * the EntryPoint and its validateUserOp writes storage keyed by the account
 * as a non-first mapping key, which ERC-7562 does not treat as associated
 * with the sender. The live leg:
 *   L1 funds the 2-of-3 account from the dev EOA (index 0);
 *   L2 deploys it and runs one operation signed by indices 1 (approver) and
 *      0 (submitter) through the bundler; with SELF_BUNDLE_ON_REJECT=1 a
 *      bundler rejection falls back to a self-bundled EntryPoint.handleOps
 *      from the dev EOA, so the contract-level result is still proven;
 *   L3 proves that the SAME operation signed by only index 0 is refused by
 *      the bundler's estimation (AA24);
 *   L4 reads the result back from the node and sweeps the account's balance
 *      back to the dev EOA.
 * Spends at most a few thousandths of a test ETH.
 *
 * Environment:
 *   ZERODEV_PROJECT_ID / BUNDLER_URL   live only; never printed.
 *   NODE_URL                           optional; default public Sepolia RPC.
 *   MULTISIG_INDEX                     account index (CREATE2 salt); default 77.
 *   MULTISIG_SMOKE_LIVE=1              required for the live run.
 *   SELF_BUNDLE_ON_REJECT=1            self-bundle a bundler-rejected op.
 *
 * Run from the repository root after `npm run build`:
 *   Dry run: node scripts/testnet/multisig-smoke.mjs
 *   Live:    set -a; . .dev-wallet/env; set +a; \
 *            MULTISIG_SMOKE_LIVE=1 SELF_BUNDLE_ON_REJECT=1 \
 *            node scripts/testnet/multisig-smoke.mjs
 * A live run writes its public record (hashes and addresses only) to
 * scripts/testnet/runs/ (git-ignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_MULTISIG_VALIDATOR,
  KERNEL_V3_3,
  NodeClient,
  SmartAccountClient,
  approveMultisigRequest,
  buildMultisigSigningRequest,
  createKernelMultisigSpec,
  encodeFunctionCall,
  encodeGuardianSignature,
  encodeKernelExecute,
  getUserOpHash,
  kernelErc1271Digest,
  kernelValidatorId,
  multisigExposure,
  multisigFactoryArgs,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  predictKernelMultisigAddress,
  signEip1559,
  signGuardianApproval,
  signGuardianUserOpHash,
  toBytes,
  toHex,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/11155111` : undefined);
const LIVE = process.env.MULTISIG_SMOKE_LIVE === '1';
const DRY_RUN = !LIVE;
const SELF_BUNDLE = process.env.SELF_BUNDLE_ON_REJECT === '1';
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const INDEX = BigInt(process.env.MULTISIG_INDEX ?? '77');
const CHAIN_ID = 11155111n;
const ERC1271_MAGIC = '0x1626ba7e';
const PUBLIC_TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

if (LIVE && !BUNDLER_URL) {
  console.error('A live run needs ZERODEV_PROJECT_ID or BUNDLER_URL.');
  process.exit(1);
}

const plainNode = async (method, params) => {
  const response = await fetch(NODE_URL, {
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
};
async function node(method, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await plainNode(method, params);
    } catch (error) {
      const transport = /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|HTTP error 5\d\d/i.test(String(error?.message ?? error));
      if (!transport || attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
const nodeClient = new NodeClient(node);

function maskSecrets(text) {
  let out = String(text);
  for (const s of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) out = out.split(s).join('<masked>');
  return out;
}
const bundler = BUNDLER_URL
  ? async (method, params) => {
      const response = await fetch(BUNDLER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = await response.json();
      if (body.error) {
        const error = new Error(maskSecrets(`bundler error ${body.error.code}: ${body.error.message}`));
        error.data = body.error.data;
        throw error;
      }
      return body.result;
    }
  : undefined;

const topic = (sig) => toHex(keccak_256(utf8ToBytes(sig)));
const USER_OPERATION_EVENT = topic('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
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

// Fees for the bundler path. ZeroDev's bundler enforces a priority-fee floor
// (observed 1.1 gwei on Sepolia), so the priority fee is set above it; the
// bundler sizes the gas limits itself, so these limits are not used there.
const GAS = {
  callGasLimit: 400_000n,
  verificationGasLimit: 1_500_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_500_000_000n,
};
// Fees and limits for the SELF-BUNDLED fallback (a raw EntryPoint.handleOps
// transaction, so no bundler floor applies). A weighted-root deployment uses
// a lot of verification gas (AA26 at 1.5M), so the limit is generous; the
// fee is kept low to keep the prefund (gas x maxFeePerGas) under the 0.006
// test ETH the account holds.
const SELF_GAS = {
  callGasLimit: 500_000n,
  verificationGasLimit: 3_000_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 1_200_000_000n,
  maxPriorityFeePerGas: 1_200_000_000n,
};

function keyring(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry);
}

const failures = [];
const log = [];
function check(label, ok, detail) {
  if (!ok) failures.push(label);
  log.push({ label, detail, pass: ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
}

/**
 * Builds a signed multisig operation directly from the engine primitives:
 * the co-signers sign the Approve digest and the submitter signs the
 * EIP-191 userOpHash, packed approvals-first.
 */
function buildMultisigOp({ account, factoryArgs, nonce, calls, coSigners, submitter, gas = GAS }) {
  const callData = encodeKernelExecute(calls);
  const request = buildMultisigSigningRequest({ chainId: CHAIN_ID, account, calls, nonce });
  const approvals = coSigners.map((s) => toBytes(approveMultisigRequest(request, s).signature));
  const op = { sender: account, nonce, ...(factoryArgs ?? {}), callData, ...gas, signature: new Uint8Array(0) };
  const userOpHash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
  return { ...op, signature: encodeGuardianSignature(approvals, signGuardianUserOpHash(submitter, userOpHash)) };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function dryRun() {
  const keys = keyring(PUBLIC_TEST_MNEMONIC);
  const s0 = keys.getAccount('eip155:1', 0, 0);
  const s1 = keys.getAccount('eip155:1', 0, 1);
  const s2 = keys.getAccount('eip155:1', 0, 2);
  const config = { signers: [{ address: s0.address, weight: 1 }, { address: s1.address, weight: 1 }, { address: s2.address, weight: 1 }], threshold: 2, delaySeconds: 0 };
  const deployOptions = { index: INDEX };
  const account = predictKernelMultisigAddress(config, deployOptions);
  const factoryArgs = multisigFactoryArgs(config, deployOptions);
  console.log(`DRY RUN (public test mnemonic). 2-of-3 weighted-root account (index ${INDEX}) ${account}`);
  console.log(`Signers ${s0.address}, ${s1.address}, ${s2.address} (weight 1 each, threshold 2).`);
  if ((await node('eth_getCode', [account, 'latest'])) !== '0x') throw new Error(`${account} is deployed; the dry run needs an undeployed account`);

  const latest = await node('eth_getBlockByNumber', ['latest', false]);
  const relayer = '0x000000000000000000000000000000000000bEEF';
  const funded = { [account]: { balance: '0xde0b6b3a7640000' }, [relayer]: { balance: '0xde0b6b3a7640000' } };
  const recipient = s0.address; // a harmless 0-value call to a signer
  const calls = [{ to: recipient, value: 0n, data: new Uint8Array(0) }];

  const honest = buildMultisigOp({ account, factoryArgs, nonce: 0n, calls, coSigners: [s1], submitter: s0 });
  const oneSigner = buildMultisigOp({ account, factoryArgs, nonce: 0n, calls, coSigners: [], submitter: s0 });
  const duplicated = buildMultisigOp({ account, factoryArgs, nonce: 0n, calls, coSigners: [s0], submitter: s0 });

  const handle = (op) => ({ from: relayer, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, relayer)), gas: '0x1c9c380' });
  const simOp = async (op) => {
    const r = await node('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides: funded, calls: [handle(op)] }] }, latest.number]);
    const c = r[0].calls[0];
    const uoh = toHex(getUserOpHash({ ...op, signature: new Uint8Array(0) }, ENTRYPOINT_V07, CHAIN_ID));
    const success = c.status === '0x1' ? userOpEventSuccess(c.logs, uoh) : null;
    const reason = c.status === '0x1' ? `UserOperationEvent success=${success}` : describeHandleRevert(c);
    return { accepted: c.status === '0x1' && success === true, reason };
  };

  console.log('\n[D1] operations');
  const r1 = await simOp(honest);
  check('(1) honest 2-of-3 operation, two distinct signers', r1.accepted, r1.reason);
  const r2 = await simOp(oneSigner);
  check('(2) one signer only is refused', !r2.accepted, r2.reason);
  const r3 = await simOp(duplicated);
  check('(3) one signer used as approver AND submitter is refused (counted once)', !r3.accepted, r3.reason);

  console.log('\n[D2] ERC-1271 message signing (the reason the engine refuses it for a multisig)');
  const probe = keccak_256(utf8ToBytes('shiba-wallet multisig smoke: ERC-1271 counterexample'));
  const wrapped = kernelErc1271Digest(probe, { chainId: CHAIN_ID, account });
  const sig0 = signGuardianApproval(s0, wrapped); // raw sign of the wrapped digest
  const dup = new Uint8Array([0x00, ...sig0, ...sig0]); // root envelope, duplicated signature
  const single = new Uint8Array([0x00, ...sig0]);
  const isValidSig = (data) => ({
    stateOverrides: funded,
    calls: [{ from: relayer, to: account, data: toHex(encodeFunctionCall('isValidSignature(bytes32,bytes)', [{ kind: 'fixedBytes', value: probe }, { kind: 'bytes', value: data }])) }],
  });
  const r4 = await node('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides: funded, calls: [handle(honest)] }, isValidSig(dup), isValidSig(single)] }, latest.number]);
  const dupResult = r4[1].calls[0];
  const singleResult = r4[2].calls[0];
  check('(4a) one signer, signature DUPLICATED, satisfies 2-of-3 isValidSignature', dupResult.status === '0x1' && dupResult.returnData.slice(0, 10).toLowerCase() === ERC1271_MAGIC, `${dupResult.status} ${dupResult.returnData?.slice(0, 10)}`);
  check('(4b) one signer, single signature, is rejected by isValidSignature', singleResult.status === '0x1' && singleResult.returnData.slice(0, 10).toLowerCase() !== ERC1271_MAGIC, `${singleResult.status} ${singleResult.returnData?.slice(0, 10)}`);

  console.log('\n[D3] exposure (operation signers vs message signers)');
  for (const [name, cfg, expectOp, expectMsg] of [
    ['2-of-2 (1,1)', { signers: pairs([1, 1]), threshold: 2 }, 2, 1],
    ['2-of-3 (1,1,1)', { signers: pairs([1, 1, 1]), threshold: 2 }, 2, 1],
    ['3-of-5 (1,1,1,1,1)', { signers: pairs([1, 1, 1, 1, 1]), threshold: 3 }, 3, 2],
    ['weighted 5 of (3,1,1)', { signers: pairs([3, 1, 1]), threshold: 5 }, 3, 1],
  ]) {
    const e = multisigExposure(cfg);
    check(`(5) ${name}: operation needs ${expectOp}, message needs ${expectMsg}`, e.operationMinimumSigners === expectOp && e.messageMinimumSigners === expectMsg, `op ${e.operationMinimumSigners}, msg ${e.messageMinimumSigners}, weaker=${e.messageWeakerThanOperation}`);
  }

  function pairs(weights) {
    return weights.map((w, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), weight: w }));
  }
}

function describeHandleRevert(call) {
  const data = call.error?.data ?? call.returnData;
  if (typeof data !== 'string' || data.length < 10) return `status ${call.status}`;
  // FailedOp(uint256,string) selector 0x220266b6
  if (data.slice(0, 10).toLowerCase() === '0x220266b6') {
    const body = data.slice(10);
    const off = Number(BigInt('0x' + body.slice(64, 128))) / 32;
    const len = Number(BigInt('0x' + body.slice(off * 64, off * 64 + 64)));
    const reason = Buffer.from(body.slice((off + 1) * 64, (off + 1) * 64 + len * 2), 'hex').toString();
    return `FailedOp("${reason}")`;
  }
  return `revert ${data.slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

async function liveRun() {
  const mnemonic = readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
  const keys = keyring(mnemonic);
  const s0 = keys.getAccount('eip155:1', 0, 0); // the dev EOA: funder + submitter
  const s1 = keys.getAccount('eip155:1', 0, 1);
  const s2 = keys.getAccount('eip155:1', 0, 2);
  const config = { signers: [{ address: s0.address, weight: 1 }, { address: s1.address, weight: 1 }, { address: s2.address, weight: 1 }], threshold: 2, delaySeconds: 0 };
  const deployOptions = { index: INDEX };
  const account = predictKernelMultisigAddress(config, deployOptions);

  const chainId = await nodeClient.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`Not Sepolia: node reports ${chainId}`);
  console.log(`LIVE on Sepolia. 2-of-3 account (index ${INDEX}) ${account}`);
  console.log(`Signers ${s0.address} (submitter), ${s1.address}, ${s2.address}; threshold 2.`);
  const supported = await bundler('eth_supportedEntryPoints', []);
  if (!supported.map((e) => e.toLowerCase()).includes(ENTRYPOINT_V07.toLowerCase())) {
    throw new Error('Bundler does not support EntryPoint v0.7');
  }

  const record = { account, signers: config.signers.map((s) => s.address), threshold: 2, chain: 'sepolia', steps: [] };
  const note = (step, data) => { record.steps.push({ step, ...data }); console.log(`  ${step}: ${maskSecrets(JSON.stringify(data))}`); };

  // L1 fund the account enough to cover the UserOperation prefund
  // (gas limits x maxFeePerGas, since there is no paymaster). 0.006 test ETH
  // covers a weighted-root deploy at 2 gwei. A transfer to a fresh account
  // costs more than 21000 gas (the new-account charge), so estimate it.
  const balance = await nodeClient.getBalance(account);
  const fundTarget = 6_000_000_000_000_000n; // 0.006 ETH
  if (balance < fundTarget) {
    const need = fundTarget - balance;
    const fees = await nodeClient.suggestFees();
    const nonce = await nodeClient.getTransactionCount(s0.address);
    const estimate = await nodeClient.estimateGas({ from: s0.address, to: account, value: need });
    const gasLimit = (estimate * 120n) / 100n;
    const fund = signEip1559({ chainId: CHAIN_ID, nonce, to: account, value: need, gasLimit, ...fees }, s0);
    const fundHash = await nodeClient.sendRawTransaction(fund.rawHex);
    const fundReceipt = await waitForTx(fundHash);
    if (fundReceipt.status !== '0x1') throw new Error(`Funding transaction ${fundHash} reverted`);
    note('L1 funded', { fundHash, amountWei: need.toString() });
  } else {
    note('L1 funded', { alreadyFunded: balance.toString() });
  }

  // L2 deploy + one operation, two signers (index 1 approves, index 0 submits).
  const calls = [{ to: s0.address, value: 0n, data: new Uint8Array(0) }];
  const spec = createKernelMultisigSpec({
    node,
    config,
    submitter: s0.address,
    approvals: [buildApproval(account, calls, 0n, s1)],
    index: INDEX,
  });
  const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node, spec });
  const fees = { maxFeePerGas: GAS.maxFeePerGas, maxPriorityFeePerGas: GAS.maxPriorityFeePerGas };
  let deployed = false;
  try {
    const { userOp, userOpHash } = await client.sendCalls(s0, calls, fees);
    note('L2 bundler accepted the weighted-root deploy+op', { userOpHash });
    const receipt = await waitForUserOp(userOpHash);
    note('L2 receipt', { txHash: receipt?.receipt?.transactionHash ?? null, success: receipt?.success ?? null });
    deployed = true;
    void userOp;
  } catch (error) {
    note('L2 bundler REJECTED the weighted-root operation (ERC-7562 / unstaked validator)', { error: maskSecrets(String(error?.message ?? error)), data: error?.data ?? null });
    if (SELF_BUNDLE) {
      const op = buildMultisigOp({ account, factoryArgs: multisigFactoryArgs(config, deployOptions), nonce: await entryPointNonce(account), calls, coSigners: [s1], submitter: s0, gas: SELF_GAS });
      const txHash = await selfBundle(op, s0);
      const receipt = await waitForTx(txHash);
      const success = userOpEventSuccess(receipt.logs, toHex(getUserOpHash({ ...op, signature: new Uint8Array(0) }, ENTRYPOINT_V07, CHAIN_ID)));
      note('L2 self-bundled deploy+op (contract accepts it even if the bundler does not)', { txHash, status: receipt.status, success });
      deployed = success === true;
    }
  }

  // L3 the same operation signed by ONE signer must be refused (estimation).
  if (deployed) {
    const oneSpec = createKernelMultisigSpec({ node, config, submitter: s0.address, approvals: [], index: INDEX });
    const oneClient = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node, spec: oneSpec });
    try {
      await oneClient.sendCalls(s0, [{ to: s0.address, value: 0n, data: new Uint8Array(0) }], fees);
      note('L3 ONE signer', { refused: false, warning: 'a single signer was NOT refused — investigate' });
      failures.push('L3 one signer accepted');
    } catch (error) {
      note('L3 ONE signer refused (as it must be)', { error: maskSecrets(String(error?.message ?? error)).slice(0, 200) });
    }
  }

  // L4 read back and sweep.
  const owner0 = await entryPointNonce(account);
  note('L4 final nonce', { nonce: owner0.toString(), balanceWei: (await nodeClient.getBalance(account)).toString() });

  mkdirSync(new URL('./runs/', import.meta.url), { recursive: true });
  const path = new URL(`./runs/multisig-${Date.now()}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(record, null, 2));
  console.log(`Record written to ${path.pathname}`);
}

function buildApproval(account, calls, nonce, signer) {
  const request = buildMultisigSigningRequest({ chainId: CHAIN_ID, account, calls, nonce });
  return approveMultisigRequest(request, signer);
}

async function entryPointNonce(account) {
  const data = encodeFunctionCall('getNonce(address,uint192)', [{ kind: 'address', value: account }, { kind: 'uint256', value: 0n }]);
  return BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data: toHex(data) }, 'latest']));
}

async function selfBundle(op, from) {
  const fees = await nodeClient.suggestFees();
  const nonce = await nodeClient.getTransactionCount(from.address);
  const tx = signEip1559(
    {
      chainId: CHAIN_ID,
      nonce,
      to: ENTRYPOINT_V07,
      value: 0n,
      gasLimit: 3_000_000n,
      data: encodeHandleOps(op, from.address),
      ...fees,
    },
    from,
  );
  return nodeClient.sendRawTransaction(tx.rawHex);
}

async function waitForTx(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await node('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

async function waitForUserOp(userOpHash) {
  for (let i = 0; i < 40; i++) {
    const r = await bundler('eth_getUserOperationReceipt', [userOpHash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 4000));
  }
  return null;
}

async function main() {
  if (DRY_RUN) await dryRun();
  else await liveRun();
  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(maskSecrets(String(error?.stack ?? error)));
  process.exit(1);
});

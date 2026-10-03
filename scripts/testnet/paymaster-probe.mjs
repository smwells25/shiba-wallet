/**
 * ERC-7677 paymaster probe for the ZeroDev project on Sepolia (phase 10,
 * item 2).
 *
 * Question answered: does the project's RPC URL already sponsor gas for the
 * dev seed's deployed Kernel v3.3 account, through the standard ERC-7677
 * methods the app uses (pm_getPaymasterStubData / pm_getPaymasterData)?
 *
 * DEFAULT MODE IS READ-ONLY. It builds an unsigned UserOperation (a 0-value
 * call from the account to its owner EOA) with engine code, then asks the
 * project RPC:
 *   - eth_supportedEntryPoints, eth_chainId
 *   - pm_getPaymasterStubData   (ERC-7677) with context null and {}
 *   - pm_getPaymasterData       (ERC-7677) with the same contexts, after
 *                               bundler gas estimation
 *   - zd_sponsorUserOperation   (the method ZeroDev's own SDK,
 *                               @zerodev/sdk 5.5.10, calls from
 *                               paymasterClient.sponsorUserOperation),
 *                               with shouldConsume=false so the probe does
 *                               not count against a sponsorship quota
 *   - pm_sponsorUserOperation   (named in ZeroDev's debugging FAQ as
 *                               Pimlico's method; tried because the project
 *                               RPC may proxy Pimlico)
 *   - zd_getUserOperationGasPrice and pimlico_getUserOperationGasPrice
 * Every response (result or error, with its HTTP status) is printed verbatim,
 * except that the project id is replaced by "<project>" wherever it appears.
 * Nothing is signed by the owner key and nothing is submitted in this mode.
 *
 * LIVE MODE (PAYMASTER_LIVE=1) additionally sends ONE sponsored
 * UserOperation through SmartAccountClient with the paymaster configured
 * exactly as the app's createAaClient does (ERC-7677 stub -> bundler
 * estimate -> final paymaster data -> owner signature -> bundler), after a
 * read-only EntryPoint.handleOps preflight. It then checks that:
 *   - the account's ETH balance did not decrease,
 *   - the account's own EntryPoint deposit did not decrease,
 *   - the bundle transaction's UserOperationEvent names the paymaster,
 *   - the paymaster's EntryPoint deposit decreased by the op's actualGasCost.
 * Live mode refuses to run if the read-only stub probe did not return
 * paymaster data, so it can never fall back to a self-paid operation.
 *
 * Environment:
 *   ZERODEV_PROJECT_ID  required; the RPC URL is
 *                       https://rpc.zerodev.app/api/v3/{id}/chain/11155111
 *                       (docs.zerodev.app/api-and-toolings/infrastructure/rpcs).
 *                       Never printed.
 *   PAYMASTER_PROVIDER  optional ?provider= value (ULTRA_RELAY, ALCHEMY,
 *                       GELATO, PIMLICO per the same docs page).
 *   PAYMASTER_CONTEXT   optional JSON used as the ERC-7677 context in live
 *                       mode; default null (the app's default when the
 *                       Settings context field is empty).
 *   NODE_URL            optional; defaults to the public Sepolia RPC.
 *   KERNEL_INDEX        optional; default 2.
 *   EXPECTED_ACCOUNT    optional; default 0x1D723b78e1D0D84Fd0531e2686285fb1B6414106
 *                       (the dev seed's index-2 Kernel account).
 *
 * Run from the repository root after `npm run build`:
 *   set -a; . .dev-wallet/env; set +a
 *   node scripts/testnet/paymaster-probe.mjs                     # read-only
 *   PAYMASTER_LIVE=1 node scripts/testnet/paymaster-probe.mjs    # one sponsored op
 */
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  NodeClient,
  SmartAccountClient,
  createKernelAccountSpec,
  encodeFunctionCall,
  getUserOpHash,
  httpTransport,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  readKernelOwner,
  toHex,
  toRpcUserOperation,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const LIVE = process.env.PAYMASTER_LIVE === '1';
const PROJECT_ID = process.env.ZERODEV_PROJECT_ID;
const PROVIDER = process.env.PAYMASTER_PROVIDER;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const INDEX = BigInt(process.env.KERNEL_INDEX ?? '2');
const EXPECTED_ACCOUNT = process.env.EXPECTED_ACCOUNT ?? '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const CHAIN_ID = 11155111n;

if (!PROJECT_ID) {
  console.error('Set ZERODEV_PROJECT_ID (for example: set -a; . .dev-wallet/env; set +a).');
  process.exit(1);
}
const PROJECT_URL =
  `https://rpc.zerodev.app/api/v3/${PROJECT_ID}/chain/${CHAIN_ID}` +
  (PROVIDER ? `?provider=${encodeURIComponent(PROVIDER)}` : '');

/** Replaces the project id (the secret part of the URL) wherever it appears. */
function mask(text) {
  return String(text).split(PROJECT_ID).join('<project>');
}
const log = (...parts) => console.log(...parts.map(mask));

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);

/**
 * A JSON-RPC call that keeps everything the server says: HTTP status and
 * the full response body (result or error), even on non-2xx answers. The
 * engine's httpTransport throws away the body on non-2xx, which would hide
 * exactly the policy errors this probe exists to record.
 */
let rpcId = 0;
async function rawRpc(method, params) {
  let response;
  try {
    response = await fetch(PROJECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
  } catch (e) {
    return { status: null, body: null, transportError: e.message };
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJsonBody: text };
  }
  return { status: response.status, body };
}

async function probe(label, method, params) {
  const r = await rawRpc(method, params);
  log(`\n--- ${label}: ${method}`);
  log(`HTTP ${r.status ?? '(no response)'}${r.transportError ? ` transport error: ${r.transportError}` : ''}`);
  log(JSON.stringify(r.body, null, 2));
  return r;
}

const USER_OPERATION_EVENT_TOPIC = toHex(
  keccak_256(utf8ToBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')),
);
const HANDLE_OPS_SIG =
  'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';

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

/** EntryPoint StakeManager deposit (balanceOf) of any address, in wei. */
async function entryPointDeposit(address) {
  const data = toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: address }]));
  return BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data }, 'latest']));
}

const fmtEth = (wei) => {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  return `${neg ? '-' : ''}${abs / 10n ** 18n}.${(abs % 10n ** 18n).toString().padStart(18, '0')} ETH (${wei} wei)`;
};

/** The paymaster fields of a 7677 result as engine UserOperation fields. */
function paymasterFieldsFromRpc(result) {
  return {
    paymaster: result.paymaster,
    paymasterData: Uint8Array.from(Buffer.from(result.paymasterData.slice(2), 'hex')),
    ...(result.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: BigInt(result.paymasterVerificationGasLimit) }
      : {}),
    ...(result.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: BigInt(result.paymasterPostOpGasLimit) }
      : {}),
  };
}

async function main() {
  log(`Mode: ${LIVE ? 'LIVE (one sponsored UserOperation)' : 'READ-ONLY probe'}`);
  log(`Project RPC: ${PROJECT_URL}`);

  const chainId = await nodeClient.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`Node is not Sepolia: chain id ${chainId}`);

  const mnemonic = readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  const owner = HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');

  const spec = createKernelAccountSpec({ node, index: INDEX });
  const sender = await spec.getAddress(owner);
  log(`Owner EOA (dev seed index 0): ${owner.address}`);
  log(`Kernel v3.3 account (index ${INDEX}): ${sender}`);
  if (sender.toLowerCase() !== EXPECTED_ACCOUNT.toLowerCase()) {
    throw new Error(`Account ${sender} is not the expected ${EXPECTED_ACCOUNT}`);
  }
  const code = await node('eth_getCode', [sender, 'latest']);
  if (!code || code === '0x') throw new Error('The Kernel account is not deployed');
  const ownerState = await readKernelOwner(node, sender);
  log(`On-chain: ECDSA root = ${ownerState.ecdsaRoot}, owner = ${ownerState.owner}`);
  if (!ownerState.ecdsaRoot || ownerState.owner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error('The account is not currently owned by the dev seed EOA through the ECDSA root');
  }

  // --- Endpoint identity -----------------------------------------------------
  await probe('identity', 'eth_chainId', []);
  await probe('identity', 'eth_supportedEntryPoints', []);
  const zdGas = await probe('gas price', 'zd_getUserOperationGasPrice', []);
  const pimGas = await probe('gas price', 'pimlico_getUserOperationGasPrice', []);

  // Fees: the node's suggestion, raised to the bundler's own quote when the
  // bundler asks for more (the app's applyPriorityFeeFloor idea, here using
  // the full standard tier because some sponsoring paymasters price against
  // it).
  let fees = await nodeClient.suggestFees();
  const tier = zdGas.body?.result?.standard ?? pimGas.body?.result?.standard;
  if (tier?.maxFeePerGas && tier?.maxPriorityFeePerGas) {
    const quotedMax = BigInt(tier.maxFeePerGas);
    const quotedPriority = BigInt(tier.maxPriorityFeePerGas);
    fees = {
      maxFeePerGas: quotedMax > fees.maxFeePerGas ? quotedMax : fees.maxFeePerGas,
      maxPriorityFeePerGas:
        quotedPriority > fees.maxPriorityFeePerGas ? quotedPriority : fees.maxPriorityFeePerGas,
    };
    if (fees.maxFeePerGas < fees.maxPriorityFeePerGas) fees.maxFeePerGas = fees.maxPriorityFeePerGas;
  }
  log(`\nFees used: maxFeePerGas ${fees.maxFeePerGas}, maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}`);

  // --- The unsigned operation ------------------------------------------------
  // The same pipeline SmartAccountClient uses: nonce from the EntryPoint,
  // calldata from the spec, the spec's stub signature, zero gas limits
  // (ERC-7677 stub calls happen before estimation).
  const readOnlyClient = new SmartAccountClient({
    chainId: CHAIN_ID,
    entryPoint: ENTRYPOINT_V07,
    bundler: httpTransport(PROJECT_URL),
    node,
    spec,
  });
  const calls = [{ to: owner.address, value: 0n, data: new Uint8Array(0) }];
  const baseOp = {
    sender,
    nonce: await readOnlyClient.getNonce(owner),
    callData: spec.encodeCalls(calls),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: spec.stubSignature(),
  };
  const chainHex = '0x' + CHAIN_ID.toString(16);
  const rpcBase = toRpcUserOperation(baseOp);
  log(`\nUnsigned op: nonce ${baseOp.nonce}, call = 0 wei to the owner EOA`);

  // --- ERC-7677 stub ----------------------------------------------------------
  const contexts = [null, {}];
  let stub = null;
  let stubContext = null;
  let stubWithoutPaymaster = false;
  for (const context of contexts) {
    const r = await probe(`ERC-7677 stub, context ${JSON.stringify(context)}`, 'pm_getPaymasterStubData', [
      rpcBase,
      ENTRYPOINT_V07,
      chainHex,
      context,
    ]);
    if (!stub && r.body?.result?.paymaster && r.body?.result?.paymasterData) {
      stub = r.body.result;
      stubContext = context;
    } else if (r.body?.result && !r.body.result.paymaster) {
      // Observed 2026-10-02 with ?provider=ULTRA_RELAY: HTTP 200 with gas
      // limits only. ERC-7677 requires paymaster + paymasterData in a v0.7
      // stub result, so this is NOT a sponsorship answer.
      stubWithoutPaymaster = true;
    }
  }

  // --- Bundler gas estimation (with the stub when one came back) -------------
  const estOp = stub ? { ...baseOp, ...paymasterFieldsFromRpc(stub) } : baseOp;
  const est = await probe(
    `bundler estimate (${stub ? 'with paymaster stub' : 'no paymaster'})`,
    'eth_estimateUserOperationGas',
    [toRpcUserOperation(estOp), ENTRYPOINT_V07],
  );
  const gas = est.body?.result;
  const estimatedOp = gas
    ? {
        ...estOp,
        callGasLimit: BigInt(gas.callGasLimit),
        verificationGasLimit: BigInt(gas.verificationGasLimit),
        preVerificationGas: BigInt(gas.preVerificationGas),
        ...(gas.paymasterVerificationGasLimit !== undefined && stub
          ? { paymasterVerificationGasLimit: BigInt(gas.paymasterVerificationGasLimit) }
          : {}),
      }
    : { ...estOp, callGasLimit: 100_000n, verificationGasLimit: 200_000n, preVerificationGas: 60_000n };

  // --- ERC-7677 final data ---------------------------------------------------
  for (const context of contexts) {
    await probe(`ERC-7677 final, context ${JSON.stringify(context)}`, 'pm_getPaymasterData', [
      toRpcUserOperation(estimatedOp),
      ENTRYPOINT_V07,
      chainHex,
      context,
    ]);
  }

  // --- Vendor methods ----------------------------------------------------------
  // Parameter shape copied from @zerodev/sdk 5.5.10
  // _esm/actions/paymaster/sponsorUserOperation.js (chainId as a number,
  // userOp hex-encoded without the paymaster fields).
  const { paymaster: _p, paymasterData: _d, paymasterVerificationGasLimit: _v, paymasterPostOpGasLimit: _o, ...noPm } =
    toRpcUserOperation(estimatedOp);
  await probe('ZeroDev SDK method', 'zd_sponsorUserOperation', [
    {
      chainId: Number(CHAIN_ID),
      userOp: noPm,
      entryPointAddress: ENTRYPOINT_V07,
      shouldOverrideFee: false,
      shouldConsume: false,
    },
  ]);
  await probe('Pimlico-style method', 'pm_sponsorUserOperation', [noPm, ENTRYPOINT_V07]);

  if (!LIVE) {
    log(`\nREAD-ONLY PROBE DONE. ERC-7677 stub ${stub ? `RETURNED paymaster ${stub.paymaster}` : 'did NOT return paymaster data'}.`);
    if (stubWithoutPaymaster) {
      log('Note: the stub call answered with a result that has NO paymaster address (gas limits only),');
      log('which is not an ERC-7677 sponsorship answer.');
    }
    log('Nothing was signed or submitted.');
    return;
  }

  // ===========================================================================
  // LIVE: one sponsored UserOperation
  // ===========================================================================
  if (!stub) {
    throw new Error('Live mode refused: the ERC-7677 stub probe returned no paymaster data, so the op would not be sponsored.');
  }
  let context = stubContext;
  if (process.env.PAYMASTER_CONTEXT !== undefined) context = JSON.parse(process.env.PAYMASTER_CONTEXT);
  log(`\nLIVE: context ${JSON.stringify(context)}`);

  // Records the signed op, refuses to submit anything without a paymaster,
  // and runs a read-only EntryPoint.handleOps preflight before submission.
  const projectTransport = httpTransport(PROJECT_URL);
  let signedOp = null;
  const bundler = async (method, params) => {
    if (method === 'eth_sendUserOperation') {
      signedOp = params[0];
      if (!signedOp.paymaster) throw new Error('Refusing to submit: the signed op carries no paymaster');
      const op = fromRpc(signedOp);
      const call = {
        from: owner.address,
        to: ENTRYPOINT_V07,
        data: toHex(encodeHandleOps(op, owner.address)),
        gas: '0x989680',
      };
      await node('eth_call', [call, 'latest']);
      log('Preflight: EntryPoint.handleOps eth_call with the sponsored op passed (validation OK).');
    }
    return projectTransport(method, params);
  };
  const client = new SmartAccountClient({
    chainId: CHAIN_ID,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    paymaster: { transport: projectTransport, context },
    // Same padding kernel-smoke.mjs used successfully on ZeroDev.
    gasPaddingPct: { verification: 110, call: 150, preVerification: 105 },
  });

  const balanceBefore = await nodeClient.getBalance(sender);
  const accountDepositBefore = await entryPointDeposit(sender);
  const stubPaymaster = stub.paymaster;
  const paymasterDepositBefore = await entryPointDeposit(stubPaymaster);
  log(`Before: account balance ${fmtEth(balanceBefore)}`);
  log(`Before: account EntryPoint deposit ${fmtEth(accountDepositBefore)}`);
  log(`Before: paymaster ${stubPaymaster} EntryPoint deposit ${fmtEth(paymasterDepositBefore)}`);

  const { userOpHash, userOp } = await client.sendCalls(owner, calls, fees);
  log(`UserOperation accepted by the bundler: ${userOpHash}`);
  log(`Signed op paymaster: ${userOp.paymaster}`);
  const receipt = await client.waitForReceipt(userOpHash, { timeoutMs: 180_000, pollMs: 5_000 });
  log(`UserOperation receipt (verbatim): ${JSON.stringify(receipt, null, 2)}`);
  const txHash = receipt?.receipt?.transactionHash ?? receipt?.transactionHash;
  if (!txHash) throw new Error('No bundle transaction hash in the receipt');

  // Independent check of the bundle transaction through the node.
  const tx = await node('eth_getTransactionReceipt', [txHash]);
  log(`Bundle tx ${txHash}: block ${Number(tx.blockNumber)}, status ${tx.status}, to ${tx.to}`);
  const event = (tx.logs ?? []).find(
    (l) =>
      l.address.toLowerCase() === ENTRYPOINT_V07.toLowerCase() &&
      l.topics?.[0]?.toLowerCase() === USER_OPERATION_EVENT_TOPIC &&
      l.topics?.[1]?.toLowerCase() === userOpHash.toLowerCase(),
  );
  if (!event) throw new Error('No UserOperationEvent for this userOpHash in the bundle transaction');
  const eventSender = '0x' + event.topics[2].slice(26);
  const eventPaymaster = '0x' + event.topics[3].slice(26);
  const word = (i) => BigInt('0x' + event.data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  const success = word(1) === 1n;
  const actualGasCost = word(2);
  const actualGasUsed = word(3);
  log(`UserOperationEvent: sender ${eventSender}, paymaster ${eventPaymaster}, success ${success},`);
  log(`  actualGasCost ${fmtEth(actualGasCost)}, actualGasUsed ${actualGasUsed}`);

  // Read balances at the bundle block (and latest, for context).
  const at = tx.blockNumber;
  const balanceAfter = BigInt(await node('eth_getBalance', [sender, at]));
  const accountDepositAfter = await (async () => {
    const data = toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: sender }]));
    return BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data }, at]));
  })();
  const paymasterDepositAfter = await (async () => {
    const data = toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: eventPaymaster }]));
    return BigInt(await node('eth_call', [{ to: ENTRYPOINT_V07, data }, at]));
  })();
  log(`After (block ${Number(at)}): account balance ${fmtEth(balanceAfter)} (change ${fmtEth(balanceAfter - balanceBefore)})`);
  log(`After: account EntryPoint deposit ${fmtEth(accountDepositAfter)} (change ${fmtEth(accountDepositAfter - accountDepositBefore)})`);
  log(`After: paymaster EntryPoint deposit ${fmtEth(paymasterDepositAfter)} (change ${fmtEth(paymasterDepositAfter - paymasterDepositBefore)})`);

  const problems = [];
  if (tx.status !== '0x1') problems.push('bundle transaction status is not 0x1');
  if (!success) problems.push('UserOperationEvent success is false');
  if (eventSender.toLowerCase() !== sender.toLowerCase()) problems.push('event sender is not the account');
  if (eventPaymaster === '0x' + '0'.repeat(40)) problems.push('event paymaster is the zero address (self-paid)');
  if (eventPaymaster.toLowerCase() !== String(userOp.paymaster).toLowerCase()) {
    problems.push('event paymaster differs from the signed op paymaster');
  }
  if (balanceAfter < balanceBefore) problems.push('the account ETH balance decreased');
  if (accountDepositAfter < accountDepositBefore) problems.push('the account EntryPoint deposit decreased');
  if (eventPaymaster.toLowerCase() === stubPaymaster.toLowerCase()) {
    // Other sponsored ops in the same block could move the deposit too, so
    // the check is "decreased by at least this op's cost", reported exactly.
    if (paymasterDepositBefore - paymasterDepositAfter < actualGasCost) {
      problems.push('the paymaster deposit did not decrease by at least actualGasCost');
    }
  }
  if (problems.length) throw new Error(`Sponsored op checks FAILED: ${problems.join('; ')}`);
  log('\nPAYMASTER LIVE PASSED: the UserOperation was sponsored by the project paymaster;');
  log('the account paid nothing and the paymaster deposit covered the gas.');
}

/** RPC (hex string) UserOperation -> engine UserOperation. */
function fromRpc(r) {
  const big = (v) => (v === undefined ? undefined : BigInt(v));
  const bytes = (h) => Uint8Array.from(Buffer.from((h ?? '0x').slice(2), 'hex'));
  return {
    sender: r.sender,
    nonce: BigInt(r.nonce),
    ...(r.factory ? { factory: r.factory, factoryData: bytes(r.factoryData) } : {}),
    callData: bytes(r.callData),
    callGasLimit: BigInt(r.callGasLimit),
    verificationGasLimit: BigInt(r.verificationGasLimit),
    preVerificationGas: BigInt(r.preVerificationGas),
    maxFeePerGas: BigInt(r.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas),
    ...(r.paymaster
      ? {
          paymaster: r.paymaster,
          paymasterVerificationGasLimit: big(r.paymasterVerificationGasLimit),
          paymasterPostOpGasLimit: big(r.paymasterPostOpGasLimit),
          paymasterData: bytes(r.paymasterData),
        }
      : {}),
    signature: bytes(r.signature),
  };
}

main().catch((e) => {
  console.error(mask(`Paymaster probe failed: ${e.message}`));
  process.exit(1);
});

/**
 * ERC-7579 / Kernel v3.3 testnet smoke test (phase 7, item 1).
 *
 * Deploys a counterfactual ZeroDev Kernel v3.3 account whose root validator
 * is the ECDSA validator owned by the dev wallet's seed-derived EOA (ADR D1),
 * through a real bundler on Sepolia, then sends a second UserOperation from
 * the deployed account. Every UserOperation is first simulated through
 * EntryPoint v0.7 handleOps with eth_call (read-only) and the script aborts
 * before contacting the bundler if that simulation reverts.
 *
 * Environment variables:
 *   CHAIN_ID      optional; 11155111 (Ethereum Sepolia, the default),
 *                 84532 (Base Sepolia, phase 10 item 3) or 421614 (Arbitrum
 *                 Sepolia, phase 15 item 0). Any other value is refused. The
 *                 node's eth_chainId must match it, and every chain-bound
 *                 value (userOpHash, self-bundled transaction) uses it. The
 *                 Kernel v3.3 addresses and EntryPoint v0.7 were verified
 *                 read-only on Base Sepolia on 2026-10-03 and on Arbitrum
 *                 Sepolia on 2026-10-04 (app/src/config/evm-chain.ts
 *                 EVM_BASE_SEPOLIA, EVM_ARBITRUM_SEPOLIA).
 *   BUNDLER_URL   endpoint for CHAIN_ID serving the eth_sendUserOperation
 *                 namespace (the dev Alchemy URL serves node and bundler
 *                 methods on Sepolia; for Base Sepolia and Arbitrum Sepolia
 *                 use the ZeroDev project URL
 *                 https://rpc.zerodev.app/api/v3/<project>/chain/<CHAIN_ID>,
 *                 which accepts Kernel deployment ops through the staked
 *                 meta factory). Probed with eth_supportedEntryPoints first.
 *                 Never printed: every log line masks it and the ZeroDev
 *                 project id.
 *   NODE_URL      optional; defaults to the public RPC of CHAIN_ID
 *                 (Sepolia: scripts/testnet/config.mjs SEPOLIA_RPC; Base
 *                 Sepolia: https://base-sepolia-rpc.publicnode.com; Arbitrum
 *                 Sepolia: https://arbitrum-sepolia-rpc.publicnode.com — each
 *                 the first default candidate of the app's profile).
 *   KERNEL_INDEX  optional account index (CREATE2 salt); default 0.
 *   KERNEL_DIRECT_FACTORY=1
 *                 optional; use KernelFactory.createAccount directly as the
 *                 UserOperation factory instead of the staked meta factory
 *                 (FactoryStaker.deployWithFactory). Same account address.
 *   SELF_BUNDLE_ON_REJECT=1
 *                 optional; if the bundler rejects the DEPLOYMENT op, submit
 *                 it ourselves via EntryPoint.handleOps from the dev EOA
 *                 (ERC-4337 permits self-bundling; this is how the
 *                 SimpleAccount deployment passed when Alchemy returned AA13).
 *   KERNEL_SMOKE_DRY_RUN=1
 *                 no keys, no broadcast: uses the PUBLIC BIP-39 test
 *                 mnemonic, a fake bundler that captures the signed op, and
 *                 simulates handleOps on Sepolia with a balance state
 *                 override (eth_simulateV1 when the node supports it, for the
 *                 UserOperationEvent success flag). BUNDLER_URL is not needed.
 *
 * Run from the repository root after `npm run build`:
 *   Live (CTO, dev wallet, Alchemy URL from the git-ignored env file):
 *     set -a; . .dev-wallet/env; set +a
 *     BUNDLER_URL="$ALCHEMY_SEPOLIA" NODE_URL="$ALCHEMY_SEPOLIA" \
 *       SELF_BUNDLE_ON_REJECT=1 node scripts/testnet/kernel-smoke.mjs
 *   Live on Base Sepolia (run 2026-10-03, phase 12) or Arbitrum Sepolia
 *   (CHAIN_ID=421614, phase 15 item 0):
 *     set -a; . .dev-wallet/env; set +a
 *     CHAIN_ID=84532 KERNEL_FUND_ETH=0.004 \
 *       BUNDLER_URL="https://rpc.zerodev.app/api/v3/$ZERODEV_PROJECT_ID/chain/84532" \
 *       node scripts/testnet/kernel-smoke.mjs
 *   Dry run (anyone, read-only; add CHAIN_ID=84532 or CHAIN_ID=421614):
 *     KERNEL_SMOKE_DRY_RUN=1 node scripts/testnet/kernel-smoke.mjs
 *
 * Layer 2 fees. Base Sepolia is an OP-stack L2: each transaction also pays
 * an L1 data fee from the sender's balance (docs.base.org/specifications/
 * transactions/network-fees), taken on top of the gas limit. Arbitrum
 * Sepolia is an Arbitrum Nitro rollup: the parent-chain cost is charged as
 * extra GAS UNITS inside the transaction's own gas limit
 * (docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas: eth_estimateGas
 * "returns a gas limit sufficient to cover the entire transaction fee"), so
 * a fixed 21,000-gas transfer can run out of gas there whenever the parent
 * chain price is non-zero. The funding transfer below therefore uses
 * eth_estimateGas (plus 20%, as fund.mjs does) on every chain, and the
 * bundler prices each L2's parent-chain cost into preVerificationGas.
 * Arbitrum collects priority fees (ArbOwnerPublic.getCollectTips() read
 * true on 2026-10-04), so the 0.15 gwei priority floor below is actually
 * paid there; it is kept on every chain so the figures stay comparable.
 */
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
} from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  NodeClient,
  SmartAccountClient,
  createKernelAccountSpec,
  encodeFunctionCall,
  getUserOpHash,
  httpTransport,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  signEip1559,
  toBytes,
  toHex,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const DRY_RUN = process.env.KERNEL_SMOKE_DRY_RUN === '1';
const BUNDLER_URL = process.env.BUNDLER_URL;
/** The test chains this smoke supports, with their default public RPC. */
const CHAINS = {
  '11155111': { name: 'Sepolia', rpc: SEPOLIA_RPC },
  // Base Sepolia: PublicNode's documented endpoint (https://base.publicnode.com),
  // the first default candidate of the app's Base Sepolia profile.
  '84532': { name: 'Base Sepolia', rpc: 'https://base-sepolia-rpc.publicnode.com' },
  // Arbitrum Sepolia: the first default candidate of the app's profile
  // (app/src/config/evm-chain.ts ARBITRUM_SEPOLIA_RPC_DEFAULTS).
  '421614': { name: 'Arbitrum Sepolia', rpc: 'https://arbitrum-sepolia-rpc.publicnode.com' },
};
/** Explorer transaction links, as in the app's profiles (explorerTxBase). */
const EXPLORER_TX = {
  '11155111': 'https://sepolia.etherscan.io/tx/',
  '84532': 'https://sepolia.basescan.org/tx/',
  '421614': 'https://sepolia.arbiscan.io/tx/',
};
const CHAIN_ID_TEXT = process.env.CHAIN_ID ?? '11155111';
if (!Object.hasOwn(CHAINS, CHAIN_ID_TEXT)) {
  console.error(`CHAIN_ID must be one of ${Object.keys(CHAINS).join(', ')} (got ${CHAIN_ID_TEXT}).`);
  process.exit(1);
}
const CHAIN = CHAINS[CHAIN_ID_TEXT];
const EXPECTED_CHAIN_ID = BigInt(CHAIN_ID_TEXT);
const NODE_URL = process.env.NODE_URL ?? CHAIN.rpc;
const INDEX = BigInt(process.env.KERNEL_INDEX ?? '0');
const DIRECT_FACTORY = process.env.KERNEL_DIRECT_FACTORY === '1';
const SELF_BUNDLE = process.env.SELF_BUNDLE_ON_REJECT === '1';
const explorerTx = (hash) => `${EXPLORER_TX[CHAIN_ID_TEXT]}${hash}`;

/**
 * A bundler gas estimate that cannot be right. Account validation always
 * uses gas (signature check, and on a deployment op the account creation),
 * so verificationGasLimit 0 is never a real estimate; likewise a zero
 * paymasterVerificationGasLimit when the operation names a paymaster.
 * Observed 2026-10-09 on ZeroDev's Arbitrum Sepolia endpoint: most answers
 * to eth_estimateUserOperationGas for the Kernel deployment op carried
 * verificationGasLimit 0x0 (with ?provider=PIMLICO and ULTRA_RELAY always;
 * the default route sometimes answered a real figure), and signing such an
 * answer produces an operation that reverts in EntryPoint.handleOps.
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

/** Masks the bundler URL and the ZeroDev project id in anything printed. */
function mask(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) {
    out = out.split(secret).join('<masked>');
  }
  return out;
}
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

if (!DRY_RUN && !BUNDLER_URL) {
  console.error(
    `Set BUNDLER_URL (${CHAIN.name} bundler RPC), or KERNEL_SMOKE_DRY_RUN=1 for a read-only dry run.`,
  );
  process.exit(1);
}

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);

const HANDLE_OPS_SIG =
  'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';
const USER_OPERATION_EVENT_TOPIC = toHex(
  keccak_256(utf8ToBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')),
);

/** EntryPoint v0.7 handleOps calldata for one op (PackedUserOperation layout). */
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

/** Decodes the success flag of a UserOperationEvent log for `userOpHash`. */
function userOpEventSuccess(logs, userOpHash) {
  for (const log of logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC) continue;
    if (log.topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    // data = nonce, success, actualGasCost, actualGasUsed
    return BigInt('0x' + log.data.slice(2 + 64, 2 + 128)) === 1n;
  }
  return null;
}

/**
 * Read-only simulation of handleOps([op]). Validation failures (bad
 * signature, failed deployment) revert the whole call; execution failures
 * do not, so eth_simulateV1 logs are used when available for the success flag.
 */
async function simulate(op, from, overrides) {
  const data = toHex(encodeHandleOps(op, from));
  const call = { from, to: ENTRYPOINT_V07, data, gas: '0x989680' };
  await node('eth_call', overrides ? [call, 'latest', overrides] : [call, 'latest']);
  const userOpHash = toHex(getUserOpHash(op, ENTRYPOINT_V07, EXPECTED_CHAIN_ID));
  try {
    const sim = await node('eth_simulateV1', [
      { blockStateCalls: [{ ...(overrides ? { stateOverrides: overrides } : {}), calls: [call] }] },
      'latest',
    ]);
    const result = sim[0].calls[0];
    return { validated: true, executed: userOpEventSuccess(result.logs, userOpHash) };
  } catch {
    return { validated: true, executed: null }; // eth_simulateV1 not offered by this node
  }
}

async function waitForTx(hash) {
  for (let i = 0; i < 45; i++) {
    const receipt = await node('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Timed out waiting for transaction ${hash}`);
}

async function main() {
  const mnemonic = DRY_RUN
    ? PUBLIC_TEST_MNEMONIC
    : readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  const owner = HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');
  console.log(`${DRY_RUN ? 'DRY RUN (public test mnemonic). ' : ''}Owner EOA: ${owner.address}`);

  const chainId = await nodeClient.chainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Not ${CHAIN.name}: the node reports chain id ${chainId}, expected ${EXPECTED_CHAIN_ID}`);
  }
  console.log(`Chain: ${CHAIN.name} (${chainId})`);

  const deployment = await verifyKernelDeployment(node, {
    metaFactory: DIRECT_FACTORY ? null : KERNEL_V3_3.metaFactory,
  });
  console.log(`Kernel deployment verified on-chain: ${JSON.stringify(deployment)}`);

  // Live mode talks to the real bundler; the dry run captures the signed op instead.
  let captured = null;
  const realBundler = DRY_RUN ? null : httpTransport(BUNDLER_URL);
  if (realBundler) {
    const supported = await realBundler('eth_supportedEntryPoints', []);
    console.log(`Bundler entry points: ${JSON.stringify(supported)}`);
    if (!supported.map((a) => a.toLowerCase()).includes(ENTRYPOINT_V07.toLowerCase())) {
      throw new Error('Bundler does not support EntryPoint v0.7');
    }
  }

  const spec = createKernelAccountSpec({
    node,
    index: INDEX,
    ...(DIRECT_FACTORY ? { metaFactory: null } : {}),
  });
  const sender = await spec.getAddress(owner);
  // Preflight: every op is simulated through the EntryPoint before the
  // bundler sees it. Wraps eth_sendUserOperation only; all else passes through.
  let lastSignedOp = null;
  const bundler = async (method, params) => {
    if (method === 'eth_sendUserOperation') {
      lastSignedOp = params[0];
      if (DRY_RUN) {
        captured = params[0];
        return '0x' + '00'.repeat(32);
      }
      const sim = await simulate(fromRpc(params[0]), owner.address);
      console.log(`Preflight handleOps simulation passed (execution success = ${sim.executed})`);
      if (sim.executed === false) throw new Error('Preflight: simulated execution failed');
    }
    if (DRY_RUN && method === 'eth_estimateUserOperationGas') {
      // Generous fixed limits; the dry run only checks validity, not pricing.
      return { callGasLimit: '0x30d40', verificationGasLimit: '0xf4240', preVerificationGas: '0x186a0' };
    }
    if (method === 'eth_estimateUserOperationGas') {
      // Refuse impossible estimates (see estimateProblem) and ask again; the
      // EntryPoint preflight below would catch them too, but only as a bare
      // revert. Nothing is signed from a refused estimate.
      for (let attempt = 1; ; attempt++) {
        const answer = await realBundler(method, params);
        const problem = estimateProblem(answer, params[0]);
        if (!problem) {
          console.log(`Bundler gas estimate (attempt ${attempt}): ${JSON.stringify(answer)}`);
          return answer;
        }
        console.log(`Bundler gas estimate refused (attempt ${attempt} of ${ESTIMATE_ATTEMPTS}): ${problem}; answer ${JSON.stringify(answer)}`);
        if (attempt >= ESTIMATE_ATTEMPTS) {
          throw new Error(`The bundler answered no usable gas estimate in ${ESTIMATE_ATTEMPTS} attempts (${problem}). Nothing was signed or sent.`);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    return realBundler(method, params);
  };

  const client = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    // Same padding that satisfied Alchemy for SimpleAccount (aa-smoke.mjs):
    // too tight fails deployment simulation, too loose trips its 0.4
    // verification-gas efficiency guard.
    gasPaddingPct: { verification: 110, call: 150, preVerification: 105 },
  });

  const deployed = await client.isDeployed(owner);
  console.log(`Kernel account (index ${INDEX}): ${sender} (deployed: ${deployed})`);

  const fees = DRY_RUN
    ? { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
    : await nodeClient.suggestFees();
  // Alchemy's bundler enforces a priority-fee floor (>= 0.1 gwei) independent
  // of the chain's fee market; pad to 0.15 gwei as aa-smoke.mjs does.
  const minPriority = 150_000_000n;
  if (fees.maxPriorityFeePerGas < minPriority) {
    fees.maxFeePerGas += minPriority - fees.maxPriorityFeePerGas;
    fees.maxPriorityFeePerGas = minPriority;
  }

  if (!DRY_RUN) {
    // Fund the account so it pays its own gas (no paymaster here).
    const balance = await nodeClient.getBalance(sender);
    // Funding target in ETH; override with KERNEL_FUND_ETH when the dev EOA
    // is running low (0.004 covers a deployment op and two single ops at
    // typical Sepolia gas prices).
    const fundEth = process.env.KERNEL_FUND_ETH ?? '0.03';
    const [fundWhole, fundFrac = ''] = fundEth.split('.');
    const target = BigInt(fundWhole) * 10n ** 18n + BigInt((fundFrac + '0'.repeat(18)).slice(0, 18));
    if (balance < target) {
      const value = target - balance;
      // Estimated, not a fixed 21,000: on Arbitrum the parent-chain cost is
      // part of the gas used (see the header), and a recipient with code may
      // need more than a plain transfer. +20% as in fund.mjs.
      const estimate = BigInt(
        await node('eth_estimateGas', [{ from: owner.address, to: sender, value: '0x' + value.toString(16) }]),
      );
      const gasLimit = (estimate * 120n) / 100n;
      const fund = signEip1559(
        {
          chainId,
          nonce: await nodeClient.getTransactionCount(owner.address),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          maxFeePerGas: fees.maxFeePerGas,
          gasLimit,
          to: sender,
          value,
        },
        owner,
      );
      const fundHash = await nodeClient.sendRawTransaction(fund.rawHex);
      console.log(`Funding the Kernel account with ${value} wei (gas estimate ${estimate}, limit ${gasLimit}): ${fundHash}`);
      console.log(`  ${explorerTx(fundHash)}`);
      const fundReceipt = await waitForTx(fundHash);
      console.log(
        `  funding status ${fundReceipt.status}, block ${BigInt(fundReceipt.blockNumber)}, gasUsed ${BigInt(fundReceipt.gasUsed)}` +
          `${fundReceipt.gasUsedForL1 ? ` (of which L1 ${BigInt(fundReceipt.gasUsedForL1)})` : ''}`,
      );
      if (fundReceipt.status !== '0x1') throw new Error('Funding transfer failed');
    }
  }

  // Op 1 (deploys if needed): an ERC-7579 BATCH — a 0-value self-call and
  // 1 wei back to the owner EOA — so the batch encoding is proven on-chain.
  const firstCalls = [
    { to: sender, value: 0n, data: new Uint8Array(0) },
    { to: owner.address, value: 1n, data: new Uint8Array(0) },
  ];
  // Op 2 (deployed path, no initCode): an ERC-7579 SINGLE 0-value self-call.
  const secondCalls = [{ to: sender, value: 0n, data: new Uint8Array(0) }];

  const overrides = DRY_RUN
    ? { [sender]: { balance: '0xde0b6b3a7640000' }, [owner.address]: { balance: '0xde0b6b3a7640000' } }
    : undefined;

  if (DRY_RUN) {
    await client.sendCalls(owner, firstCalls, fees);
    const op = fromRpc(captured);
    console.log(`Signed op: sender ${op.sender} nonce ${op.nonce} factory ${op.factory ?? '(none)'}`);
    const result = await simulate(op, owner.address, overrides);
    console.log(
      `EntryPoint.handleOps simulation: validation passed; execution success = ${result.executed}`,
    );
    if (result.executed === false) throw new Error('Simulated execution reported success=false');
    console.log('\nDRY RUN PASSED: engine-built Kernel op validates (and executes) against the');
    console.log(`real EntryPoint v0.7 and Kernel v3.3 contracts on ${CHAIN.name}. Nothing was broadcast.`);
    return;
  }

  // Live: op 1, with preflight and optional self-bundling of the deployment.
  const firstHash = await sendWithPreflight(client, owner, firstCalls, fees, {
    allowSelfBundle: SELF_BUNDLE && !deployed,
    getLastSignedOp: () => lastSignedOp,
  });
  console.log(`Op 1 done: ${firstHash}`);

  const code = await node('eth_getCode', [sender, 'latest']);
  if (!code || code === '0x') throw new Error('Kernel account still has no code after op 1');

  // On-chain proof of D1: the root validator is the ECDSA validator and its
  // stored owner is the seed-derived EOA.
  const rootWord = toBytes(await node('eth_call', [
    { to: sender, data: toHex(encodeFunctionCall('rootValidator()', [])) },
    'latest',
  ]));
  const rootId = toHex(rootWord.slice(0, 21));
  const expectedRoot = ('0x01' + KERNEL_V3_3.ecdsaValidator.slice(2)).toLowerCase();
  const ownerWord = await node('eth_call', [
    {
      to: KERNEL_V3_3.ecdsaValidator,
      data: toHex(
        encodeFunctionCall('ecdsaValidatorStorage(address)', [{ kind: 'address', value: sender }]),
      ),
    },
    'latest',
  ]);
  const storedOwner = '0x' + ownerWord.slice(26);
  console.log(`rootValidator() = ${rootId}; validator owner = ${storedOwner}`);
  if (rootId.toLowerCase() !== expectedRoot) throw new Error('Unexpected root validator');
  if (storedOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error('ECDSA validator owner is not the seed-derived EOA');
  }

  // Op 2 through the bundler, deployed path.
  const secondHash = await sendWithPreflight(client, owner, secondCalls, fees, {
    allowSelfBundle: false,
    getLastSignedOp: () => lastSignedOp,
  });
  console.log(`Op 2 done: ${secondHash}`);

  console.log(`\nKERNEL SMOKE PASSED: ERC-7579 Kernel v3.3 account ${sender} deployed at the`);
  console.log('engine-predicted address, root validator owned by the dev seed EOA (D1),');
  console.log(`batch and single executions confirmed on ${CHAIN.name}.`);
}

/** RPC (hex string) UserOperation -> engine UserOperation. */
function fromRpc(r) {
  const big = (v) => (v === undefined ? undefined : BigInt(v));
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
    ...(r.paymaster
      ? {
          paymaster: r.paymaster,
          paymasterVerificationGasLimit: big(r.paymasterVerificationGasLimit),
          paymasterPostOpGasLimit: big(r.paymasterPostOpGasLimit),
          paymasterData: toBytes(r.paymasterData ?? '0x'),
        }
      : {}),
    signature: toBytes(r.signature),
  };
}

/**
 * Sends one op through SmartAccountClient (whose bundler transport runs the
 * EntryPoint preflight and records the signed op), waits for the bundler
 * receipt, and optionally self-bundles a deployment op the bundler rejected.
 * A preflight failure is never self-bundled: the op itself is invalid.
 */
async function sendWithPreflight(client, owner, calls, fees, { allowSelfBundle, getLastSignedOp }) {
  try {
    const { userOpHash, userOp } = await client.sendCalls(owner, calls, fees);
    console.log(`UserOperation accepted by bundler: ${userOpHash}`);
    console.log(
      `  signed gas: preVerificationGas ${userOp.preVerificationGas}, verificationGasLimit ${userOp.verificationGasLimit}, ` +
        `callGasLimit ${userOp.callGasLimit}, maxFeePerGas ${userOp.maxFeePerGas}, maxPriorityFeePerGas ${userOp.maxPriorityFeePerGas}` +
        `${userOp.factory ? `, factory ${userOp.factory}` : ''}`,
    );
    const receipt = await client.waitForReceipt(userOpHash, { timeoutMs: 180_000, pollMs: 5_000 });
    const success = receipt?.success;
    const txHash = receipt?.receipt?.transactionHash;
    console.log(`UserOperation receipt: success=${JSON.stringify(success)} tx=${txHash ?? '?'}`);
    if (receipt?.actualGasCost !== undefined) {
      console.log(`  actualGasCost ${BigInt(receipt.actualGasCost)} wei, actualGasUsed ${BigInt(receipt.actualGasUsed)}`);
    }
    if (txHash) console.log(`  ${explorerTx(txHash)}`);
    if (success !== true && success !== '0x1') throw new Error('UserOperation did not succeed');
    return userOpHash;
  } catch (error) {
    const signed = getLastSignedOp();
    if (!allowSelfBundle || !signed || /^Preflight|\(eth_call\)$/.test(error.message)) {
      throw error;
    }
    console.log(mask(`Bundler rejected the deployment op (${error.message}); self-bundling via handleOps.`));
    return selfBundle(fromRpc(signed), owner, fees);
  }
}

/** Submits handleOps([op]) from the dev EOA (ERC-4337 permits any bundler). */
async function selfBundle(op, owner, fees) {
  const data = encodeHandleOps(op, owner.address);
  const gas = BigInt(
    await node('eth_estimateGas', [{ from: owner.address, to: ENTRYPOINT_V07, data: toHex(data) }]),
  );
  const tx = signEip1559(
    {
      chainId: EXPECTED_CHAIN_ID,
      nonce: await nodeClient.getTransactionCount(owner.address),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit: (gas * 130n) / 100n,
      to: ENTRYPOINT_V07,
      value: 0n,
      data,
    },
    owner,
  );
  const hash = await nodeClient.sendRawTransaction(tx.rawHex);
  console.log(`Self-bundled handleOps transaction: ${hash}`);
  const receipt = await waitForTx(hash);
  const userOpHash = toHex(getUserOpHash(op, ENTRYPOINT_V07, EXPECTED_CHAIN_ID));
  const success = userOpEventSuccess(receipt.logs, userOpHash);
  console.log(`handleOps status ${receipt.status}; UserOperationEvent success=${success}`);
  if (receipt.status !== '0x1' || success !== true) throw new Error('Self-bundled op failed');
  return userOpHash;
}

main().catch((e) => {
  console.error(mask(`Kernel smoke failed: ${e.message}`));
  process.exit(1);
});

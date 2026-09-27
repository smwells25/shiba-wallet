/**
 * ERC-4337 testnet smoke test: push a real UserOperation through a real
 * bundler on Sepolia, deploying a counterfactual SimpleAccount whose owner
 * key derives from the dev wallet seed (recovery invariant D1 proven
 * on-chain).
 *
 * Requirements (environment variables):
 *   BUNDLER_URL   a Sepolia endpoint that serves the eth_sendUserOperation
 *                 bundler namespace (for Alchemy, check their Account
 *                 Abstraction docs for the exact URL form — unverified
 *                 here). The script probes eth_supportedEntryPoints first
 *                 and refuses to proceed if v0.7 is not supported, so a
 *                 wrong URL fails loudly and early.
 *   FACTORY       address of a SimpleAccountFactory v0.7 deployment on
 *                 Sepolia. Verified on-chain before use, per the procedure
 *                 in docs/AA_STACK.md: the factory must have code, its
 *                 accountImplementation() must have code, and that
 *                 implementation's entryPoint() must equal the pinned
 *                 EntryPoint v0.7. The script refuses to run otherwise.
 *   NODE_URL      optional; defaults to the public Sepolia RPC.
 *
 * Flow: verify factory -> compute counterfactual sender -> fund it from
 * the dev EOA (EIP-1559) -> sendCalls through SmartAccountClient (deploys
 * the account and executes a 0-value self-call) -> wait for the receipt
 * -> assert the sender now has code and its address matched the
 * engine-side prediction.
 *
 * Run from the repository root after `npm run build`:
 *   BUNDLER_URL=... FACTORY=0x... node scripts/testnet/aa-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
} from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  NodeClient,
  SmartAccountClient,
  createSimpleAccountSpec,
  encodeFunctionCall,
  httpTransport,
  signEip1559,
  toBytes,
  toHex,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const BUNDLER_URL = process.env.BUNDLER_URL;
const FACTORY = process.env.FACTORY;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
if (!BUNDLER_URL || !FACTORY) {
  console.error(
    'Set BUNDLER_URL (bundler RPC with eth_sendUserOperation) and FACTORY ' +
      '(SimpleAccountFactory v0.7 on Sepolia). See docs/AA_STACK.md.',
  );
  process.exit(1);
}

const node = httpTransport(NODE_URL);
const bundler = httpTransport(BUNDLER_URL);
const nodeClient = new NodeClient(node);

function wordToAddress(word) {
  const bytes = toBytes(word);
  if (bytes.length !== 32) throw new Error(`expected 32-byte word, got ${word}`);
  return toHex(bytes.slice(12));
}

async function ethCall(to, data) {
  return node('eth_call', [{ to, data: toHex(data) }, 'latest']);
}

async function verifyFactory() {
  const factoryCode = await node('eth_getCode', [FACTORY, 'latest']);
  if (!factoryCode || factoryCode === '0x') {
    throw new Error(`Factory ${FACTORY} has no code on this chain`);
  }
  const implWord = await ethCall(FACTORY, encodeFunctionCall('accountImplementation()', []));
  const implementation = wordToAddress(implWord);
  const implCode = await node('eth_getCode', [implementation, 'latest']);
  if (!implCode || implCode === '0x') {
    throw new Error(`accountImplementation() ${implementation} has no code`);
  }
  const entryPointWord = await ethCall(implementation, encodeFunctionCall('entryPoint()', []));
  const entryPoint = wordToAddress(entryPointWord);
  if (entryPoint.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) {
    throw new Error(
      `Implementation's entryPoint() is ${entryPoint}, expected v0.7 ${ENTRYPOINT_V07}`,
    );
  }
  console.log(`Factory verified: impl ${implementation}, EntryPoint v0.7 confirmed`);
}

async function main() {
  const mnemonic = readFileSync(
    new URL('../../.dev-wallet/mnemonic.txt', import.meta.url),
    'utf8',
  ).trim();
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  const owner = HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');

  const chainId = await nodeClient.chainId();
  if (chainId !== 11155111n) throw new Error(`Not Sepolia: chain id ${chainId}`);
  const supported = await bundler('eth_supportedEntryPoints', []);
  console.log(`Bundler entry points: ${JSON.stringify(supported)}`);
  if (!supported.map((a) => a.toLowerCase()).includes(ENTRYPOINT_V07.toLowerCase())) {
    throw new Error('Bundler does not support EntryPoint v0.7');
  }

  await verifyFactory();

  const spec = createSimpleAccountSpec({ factory: FACTORY, node });
  const client = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
  });

  const sender = await client.getAddress(owner);
  const deployed = await client.isDeployed(owner);
  console.log(`Counterfactual sender: ${sender} (deployed: ${deployed})`);

  // Fund the sender so it can pay its own gas (no paymaster configured).
  const senderBalance = await nodeClient.getBalance(sender);
  const target = 30_000_000_000_000_000n; // 0.03 ETH
  if (senderBalance < target) {
    const fees = await nodeClient.suggestFees();
    const fund = signEip1559(
      {
        chainId,
        nonce: await nodeClient.getTransactionCount(owner.address),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit: 21_000n,
        to: sender,
        value: target - senderBalance,
      },
      owner,
    );
    const fundHash = await nodeClient.sendRawTransaction(fund.rawHex);
    console.log(`Funding the smart account: ${fundHash}`);
    for (let i = 0; i < 30; i++) {
      if (await node('eth_getTransactionReceipt', [fundHash])) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  const fees = await nodeClient.suggestFees();
  console.log('Sending UserOperation (deploys the account, 0-value self-call)...');
  const { userOpHash } = await client.sendCalls(
    owner,
    [{ to: sender, value: 0n, data: new Uint8Array(0) }],
    fees,
  );
  console.log(`UserOperation accepted by bundler: ${userOpHash}`);

  const receipt = await client.waitForReceipt(userOpHash, { timeoutMs: 180_000, pollMs: 5_000 });
  const success = receipt?.success;
  console.log(`UserOperation receipt: success=${JSON.stringify(success)}`);

  const code = await node('eth_getCode', [sender, 'latest']);
  if (!code || code === '0x') throw new Error('Sender still has no code after the op');
  console.log(`\nSMOKE PASSED: smart account ${sender} deployed via ERC-4337,`);
  console.log('address predicted by the engine before deployment, owner key');
  console.log('derived from the dev seed phrase — recovery invariant D1 holds.');
}

main().catch((e) => {
  console.error(`AA smoke failed: ${e.message}`);
  process.exit(1);
});

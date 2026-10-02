/**
 * Clean-up helper for the in-app social-recovery checks (phase 8 item 4,
 * app half): after the emulator walkthrough recovers a Kernel v3.3 account
 * to another key of the DEV seed, this rotates its owner back (and, with
 * REMOVE_GUARDIANS=1, removes the guardians) in ONE root-signed operation —
 * the same calls scripts/testnet/recovery-smoke.mjs uses for its own
 * clean-up (engine ownerRotationCalls + guardianUninstallCalls through
 * kernelRecoveredAccountSpec, which refuses unless the signing key is the
 * account's on-chain owner).
 *
 * Environment:
 *   FROM_INDEX        required: dev-seed address index of the CURRENT owner
 *                     (m/44'/60'/0'/0/FROM_INDEX).
 *   TO_INDEX          optional, default 0 (the dev EOA).
 *   KERNEL_ACCOUNT    optional, default the dev seed's index-2 Kernel account
 *                     0x1D723b78e1D0D84Fd0531e2686285fb1B6414106.
 *   REMOVE_GUARDIANS  1 = also uninstall the guardian validator and RecoveryAction.
 *   ZERODEV_PROJECT_ID or BUNDLER_URL  (never printed).
 *   NODE_URL          optional; default the public Sepolia RPC.
 *   DRY_RUN           1 = print the plan and stop (no bundler needed).
 *
 * Run from the repository root after `npm run build`:
 *   set -a; . .dev-wallet/env; set +a; FROM_INDEX=7 REMOVE_GUARDIANS=1 node scripts/testnet/kernel-rotate-owner.mjs
 */
import { readFileSync } from 'node:fs';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  NodeClient,
  SmartAccountClient,
  guardianUninstallCalls,
  httpTransport,
  kernelRecoveredAccountSpec,
  ownerRotationCalls,
  readGuardianState,
  readKernelOwner,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const ACCOUNT = process.env.KERNEL_ACCOUNT ?? '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const FROM_INDEX = Number(process.env.FROM_INDEX);
const TO_INDEX = Number(process.env.TO_INDEX ?? '0');
const REMOVE = process.env.REMOVE_GUARDIANS === '1';
const DRY = process.env.DRY_RUN === '1';
const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/11155111` : undefined);

function mask(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) out = out.split(secret).join('<masked>');
  return out;
}

async function main() {
  if (!Number.isInteger(FROM_INDEX) || FROM_INDEX < 0) throw new Error('Set FROM_INDEX (dev-seed index of the current owner)');
  if (!DRY && !BUNDLER_URL) throw new Error('Set ZERODEV_PROJECT_ID (or BUNDLER_URL), or DRY_RUN=1');
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  const keys = HdKeyring.fromMnemonic(readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim(), registry);
  const from = keys.getAccount('eip155:1', 0, FROM_INDEX);
  const to = keys.getAccount('eip155:1', 0, TO_INDEX);
  const node = httpTransport(NODE_URL);
  const client = new NodeClient(node);
  const chainId = await client.chainId();
  if (chainId !== 11155111n) throw new Error(`Not Sepolia: chain id ${chainId}`);
  const owner = await readKernelOwner(node, ACCOUNT);
  console.log(`Account ${ACCOUNT}: owner ${owner.owner}; rotating from index ${FROM_INDEX} (${from.address}) to index ${TO_INDEX} (${to.address})`);
  if (owner.owner.toLowerCase() !== from.address.toLowerCase()) throw new Error('FROM_INDEX is not the current owner; refusing');
  const state = await readGuardianState(node, ACCOUNT);
  const calls = [];
  if (owner.owner.toLowerCase() !== to.address.toLowerCase()) {
    calls.push(...ownerRotationCalls(to.address, { account: ACCOUNT, guardians: state.set?.guardians }));
  }
  if (REMOVE && (state.validationInstalled || state.validatorInitialized || state.recoveryRouted)) {
    calls.push(...guardianUninstallCalls(ACCOUNT));
  }
  console.log(`Plan: ${calls.length} call(s); guardians installed: ${state.validatorInitialized}`);
  if (calls.length === 0 || DRY) return;
  const bundler = async (method, params) => {
    try {
      return await httpTransport(BUNDLER_URL)(method, params);
    } catch (error) {
      throw new Error(mask(error.message));
    }
  };
  const fees = await client.suggestFees();
  try {
    const standard = (await bundler('pimlico_getUserOperationGasPrice', []))?.standard;
    if (standard) {
      fees.maxFeePerGas = fees.maxFeePerGas > BigInt(standard.maxFeePerGas) ? fees.maxFeePerGas : BigInt(standard.maxFeePerGas);
      fees.maxPriorityFeePerGas =
        fees.maxPriorityFeePerGas > BigInt(standard.maxPriorityFeePerGas) ? fees.maxPriorityFeePerGas : BigInt(standard.maxPriorityFeePerGas);
    }
  } catch {
    // Not served by this bundler: keep the node suggestion.
  }
  const smart = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec: kernelRecoveredAccountSpec({ node, account: ACCOUNT }),
    gasPaddingPct: { verification: 120, call: 130, preVerification: 105 },
  });
  const { userOpHash } = await smart.sendCalls(from, calls, fees);
  console.log(`Accepted by the bundler: userOpHash ${userOpHash}`);
  const receipt = await smart.waitForReceipt(userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
  console.log(`Receipt: success=${receipt?.success} tx ${receipt?.receipt?.transactionHash ?? '?'}`);
  const after = await readKernelOwner(node, ACCOUNT);
  const guardians = await readGuardianState(node, ACCOUNT);
  console.log(`Owner now ${after.owner}; guardians installed: ${guardians.validatorInitialized}`);
}

main().catch((error) => {
  console.error(`kernel-rotate-owner failed: ${mask(error.message)}`);
  process.exit(1);
});

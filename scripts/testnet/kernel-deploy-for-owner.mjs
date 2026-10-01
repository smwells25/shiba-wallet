/**
 * Deploys a Kernel v3.3 account for an arbitrary OWNER address from the
 * dev EOA (a plain EIP-1559 transaction to KernelFactory.createAccount),
 * and optionally seeds the new account with test ETH.
 *
 * Why this exists: Alchemy's bundler rejects Kernel deployment
 * UserOperations under the ERC-7562 rules (see AGENTS.md, phase 7), so the
 * emulator wallet's smart account cannot be created through the app's
 * bundler path. KernelFactory.createAccount is permissionless, so anyone
 * may pay to deploy the account for a given owner; the owner's key is not
 * needed and nothing is signed on the owner's behalf. The resulting account
 * is identical to the one the app predicts, because the salt and init data
 * depend only on the owner address, the validator and the index.
 *
 * Usage (Sepolia only; the dev mnemonic in .dev-wallet pays):
 *   OWNER=0x... [KERNEL_INDEX=0] [FUND_ETH=0.003] [NODE_URL=...] \
 *     node scripts/testnet/kernel-deploy-for-owner.mjs
 */
import { readFileSync } from 'node:fs';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  KERNEL_V3_3,
  NodeClient,
  encodeFunctionCall,
  encodeKernelInitData,
  httpTransport,
  predictKernelAddress,
  signEip1559,
  toHex,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const OWNER = process.env.OWNER;
const INDEX = BigInt(process.env.KERNEL_INDEX ?? '0');
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const FUND_ETH = process.env.FUND_ETH ?? '0';

if (!OWNER || !/^0x[0-9a-fA-F]{40}$/.test(OWNER)) {
  console.error('Set OWNER to the account owner address (0x + 40 hex).');
  process.exit(1);
}

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);

function word32(value) {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function parseEth(text) {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

async function waitReceipt(hash) {
  for (let i = 0; i < 60; i++) {
    const receipt = await node('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`No receipt for ${hash} after 4 minutes`);
}

async function sendFromPayer(payer, tx) {
  const fees = await nodeClient.suggestFees();
  const signed = signEip1559(
    {
      chainId: 11155111n,
      nonce: await nodeClient.getTransactionCount(payer.address),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      ...tx,
    },
    payer,
  );
  const hash = await nodeClient.sendRawTransaction(signed.rawHex);
  const receipt = await waitReceipt(hash);
  if (receipt.status !== '0x1') throw new Error(`Transaction ${hash} failed (status ${receipt.status})`);
  return { hash, receipt };
}

async function main() {
  const chainId = await nodeClient.chainId();
  if (chainId !== 11155111n) throw new Error(`Not Sepolia: chain id ${chainId}`);

  const mnemonic = readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  const payer = HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');
  console.log(`Payer (dev EOA): ${payer.address}`);

  const predicted = predictKernelAddress(OWNER, { index: INDEX });
  console.log(`Owner ${OWNER}, index ${INDEX} -> Kernel account ${predicted}`);

  const codeBefore = await node('eth_getCode', [predicted, 'latest']);
  if (codeBefore && codeBefore !== '0x') {
    console.log('Already deployed; nothing to do for deployment.');
  } else {
    const data = encodeFunctionCall('createAccount(bytes,bytes32)', [
      { kind: 'bytes', value: encodeKernelInitData(OWNER, KERNEL_V3_3.ecdsaValidator) },
      { kind: 'fixedBytes', value: word32(INDEX) },
    ]);
    const gasHex = await node('eth_estimateGas', [
      { from: payer.address, to: KERNEL_V3_3.factory, data: toHex(data) },
    ]);
    const gasLimit = (BigInt(gasHex) * 120n) / 100n;
    console.log(`createAccount gas estimate ${BigInt(gasHex)} (limit ${gasLimit})`);
    const { hash } = await sendFromPayer(payer, {
      gasLimit,
      to: KERNEL_V3_3.factory,
      value: 0n,
      data,
    });
    console.log(`Deployment transaction: ${hash}`);
    const codeAfter = await node('eth_getCode', [predicted, 'latest']);
    if (!codeAfter || codeAfter === '0x') throw new Error('Predicted address still has no code');
    console.log(`Code present at ${predicted} (${(codeAfter.length - 2) / 2} bytes)`);
  }

  // Read-only check that the on-chain root validator is the ECDSA validator.
  const rootValidator = await node('eth_call', [
    { to: predicted, data: toHex(encodeFunctionCall('rootValidator()', [])) },
    'latest',
  ]).catch(() => null);
  if (rootValidator) console.log(`rootValidator() = ${rootValidator}`);

  const fund = parseEth(FUND_ETH);
  if (fund > 0n) {
    // A deployed Kernel account runs code on receive, so a plain-transfer
    // gas limit of 21,000 is not enough; estimate it.
    const fundGasHex = await node('eth_estimateGas', [
      { from: payer.address, to: predicted, value: '0x' + fund.toString(16) },
    ]);
    const fundGas = (BigInt(fundGasHex) * 120n) / 100n;
    const { hash } = await sendFromPayer(payer, { gasLimit: fundGas, to: predicted, value: fund });
    console.log(`Funded ${FUND_ETH} ETH: ${hash}`);
  }
  console.log('DONE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

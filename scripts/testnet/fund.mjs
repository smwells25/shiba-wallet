/**
 * Sends test ETH from the dev EOA (the mnemonic in .dev-wallet) to an
 * address on Sepolia with a plain EIP-1559 transfer. Intended for topping
 * up test accounts during live validation.
 *
 * Usage: TO=0x... ETH=0.0015 [NODE_URL=...] node scripts/testnet/fund.mjs
 *   NODE_URL may point at Ethereum Sepolia (default) or Base Sepolia
 *   (https://base-sepolia-rpc.publicnode.com); other chains are refused.
 */
import { readFileSync } from 'node:fs';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import { NodeClient, httpTransport, signEip1559 } from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const TO = process.env.TO;
const ETH = process.env.ETH;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
if (!TO || !/^0x[0-9a-fA-F]{40}$/.test(TO) || !ETH || !/^\d+(\.\d+)?$/.test(ETH)) {
  console.error('Set TO (0x + 40 hex) and ETH (decimal amount).');
  process.exit(1);
}

function parseEth(text) {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);
const chainId = await nodeClient.chainId();
// Test networks only: Ethereum Sepolia by default, Base Sepolia when the
// node reports it. Anything else (a mainnet in particular) is refused.
const ALLOWED_TEST_CHAINS = [11155111n, 84532n];
if (!ALLOWED_TEST_CHAINS.includes(chainId)) throw new Error(`Not a supported test network: chain id ${chainId}`);

const mnemonic = readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
const registry = new ChainRegistry();
registry.register(evmKeyProvider);
const payer = HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');

// A recipient with code (for example a deployed or delegated smart account)
// may need more than a plain transfer's 21,000 gas, so the limit is estimated.
const value = parseEth(ETH);
const gasHex = await node('eth_estimateGas', [{ from: payer.address, to: TO, value: '0x' + value.toString(16) }]);
const fees = await nodeClient.suggestFees();
const signed = signEip1559(
  {
    chainId,
    nonce: await nodeClient.getTransactionCount(payer.address),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    gasLimit: (BigInt(gasHex) * 120n) / 100n,
    to: TO,
    value,
  },
  payer,
);
const hash = await nodeClient.sendRawTransaction(signed.rawHex);
console.log(`Sent ${ETH} ETH from ${payer.address} to ${TO}: ${hash}`);
for (let i = 0; i < 60; i++) {
  const receipt = await node('eth_getTransactionReceipt', [hash]);
  if (receipt) {
    console.log(`status ${receipt.status} in block ${Number(receipt.blockNumber)}`);
    process.exit(receipt.status === '0x1' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 4000));
}
throw new Error('No receipt after 4 minutes');

/**
 * End-to-end demonstration of the Shiba Wallet engine, runnable entirely
 * offline. One BIP-39 seed phrase drives everything below: addresses on all
 * four launch chains, a signed Bitcoin transaction, and a signed ERC-4337
 * UserOperation for a counterfactual smart account.
 *
 * Run from the repository root after `npm run build`:
 *   node examples/demo.mjs
 *
 * The mnemonic is the standard all-zero-entropy BIP-39 test phrase used by
 * the official BIP-84 test vectors. Never fund it.
 */
import {
  ChainRegistry,
  HdKeyring,
  createMnemonic,
  evmKeyProvider,
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  solanaKeyProvider,
  AssetRegistry,
  parseAssetId,
} from '../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  SmartAccountClient,
  createSimpleAccountSpec,
  toHex,
} from '../packages/chains-evm/dist/index.js';
import {
  BITCOIN,
  buildTransfer,
  signTransaction,
  transactionId,
  serializeTransaction,
} from '../packages/chains-utxo/dist/index.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

console.log('=== Shiba Wallet engine demo (fully offline) ===\n');

// 1. One seed, every chain.
const registry = new ChainRegistry();
for (const provider of [evmKeyProvider, bitcoinKeyProvider, dogecoinKeyProvider, solanaKeyProvider]) {
  registry.register(provider);
}
const keyring = HdKeyring.fromMnemonic(TEST_MNEMONIC, registry);

console.log('1. Addresses derived from a single seed phrase:');
for (const provider of registry.list()) {
  const account = keyring.getAccount(provider.chainId);
  console.log(`   ${provider.name.padEnd(9)} ${account.path.padEnd(22)} ${account.address}`);
}

// A freshly generated wallet works the same way; shown here for completeness.
const fresh = createMnemonic();
console.log(`\n   (a brand-new wallet would start from e.g. "${fresh.split(' ').slice(0, 3).join(' ')} ..." — 12 words, generated on-device)`);

// 2. Track any fungible or non-fungible asset via CAIP-19 ids.
const assets = new AssetRegistry();
assets.add({
  kind: 'fungible',
  assetId: parseAssetId('eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
});
console.log(`\n2. Asset registry tracks ${assets.list().length} asset (USDC as CAIP-19: ${'eip155:1/erc20:0xa0b8...eb48'}); any ERC-20/721/1155 or SPL token fits the same model.`);

// 3. Sign a Bitcoin transaction offline (fake UTXO; broadcast not attempted).
const btc = keyring.getAccount(bitcoinKeyProvider.chainId);
const transfer = buildTransfer({
  network: BITCOIN,
  fromAddress: btc.address,
  utxos: [{ txid: 'aa'.repeat(32), vout: 0, value: 60_000n }],
  toAddress: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
  amount: 25_000n,
  feeRate: 5,
});
const signed = signTransaction(transfer.tx, btc);
const raw = serializeTransaction(signed.tx, signed.signedInputs);
console.log(`\n3. Bitcoin: built and signed a P2WPKH spend offline.`);
console.log(`   txid: ${transactionId(signed.tx, signed.signedInputs)}`);
console.log(`   fee:  ${transfer.fee} sats at 5 sat/vB (change back to sender)`);
console.log(`   raw:  ${bytesToHex(raw).slice(0, 48)}... (${raw.length} bytes, ready to broadcast)`);

// 4. Build and sign an ERC-4337 UserOperation against fake infrastructure.
const owner = keyring.getAccount(evmKeyProvider.chainId);
// Factory getAddress returns a 32-byte word; fake a plausible one.
const nodeTransport = async (method, params) => {
  if (method === 'eth_call' && params[0].to !== ENTRYPOINT_V07) {
    return '0x' + '00'.repeat(12) + 'ab'.repeat(20);
  }
  if (method === 'eth_call') return '0x0'; // EntryPoint.getNonce -> 0
  if (method === 'eth_getCode') return '0x'; // account not deployed yet
  throw new Error(`unexpected node method ${method}`);
};
const bundlerTransport = async (method) => {
  if (method === 'eth_estimateUserOperationGas') {
    return { callGasLimit: '0x30000', verificationGasLimit: '0x60000', preVerificationGas: '0xc000' };
  }
  if (method === 'eth_sendUserOperation') return '0x' + 'f00d'.repeat(16);
  throw new Error(`unexpected bundler method ${method}`);
};
const client = new SmartAccountClient({
  chainId: 8453n, // Base
  entryPoint: ENTRYPOINT_V07,
  bundler: bundlerTransport,
  node: nodeTransport,
  spec: createSimpleAccountSpec({
    factory: '0x9406Cc6185a346906296840746125a0E44976454',
    node: nodeTransport,
  }),
});
const { userOp, userOpHash } = await client.sendCalls(
  owner,
  [{ to: '0x2222222222222222222222222222222222222222', value: 1n, data: new Uint8Array(0) }],
  { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n },
);
console.log(`\n4. ERC-4337: built, sponsored-shaped, and signed a UserOperation for an`);
console.log(`   undeployed (counterfactual) smart account — recoverable from the seed alone.`);
console.log(`   sender:     ${userOp.sender}`);
console.log(`   factory:    ${userOp.factory} (deploys on first send)`);
console.log(`   owner sig:  ${toHex(userOp.signature).slice(0, 24)}... (65 bytes, EIP-191 over userOpHash)`);
console.log(`   accepted:   ${userOpHash} (fake bundler)`);

console.log('\nEverything above ran with zero network access: the engine is');
console.log('non-custodial by construction — keys never have a code path off-device.');

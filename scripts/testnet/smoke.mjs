/**
 * Testnet smoke test (phase 2, task 8, step 2 of 2): broadcast one real
 * transaction per funded chain family using ONLY the wallet engine, then
 * confirm it landed. Run setup.mjs first and fund the printed addresses.
 *
 * Each chain sends a tiny amount to the wallet's own address (self-send),
 * so nothing is lost but fees. Skips chains with no balance.
 *
 * Run from the repository root after `npm run build`:
 *   node scripts/testnet/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import {
  ChainRegistry,
  HdKeyring,
  createUtxoKeyProvider,
  evmKeyProvider,
  solanaKeyProvider,
} from '../../packages/core/dist/index.js';
import {
  NodeClient,
  httpTransport,
  signEip1559,
} from '../../packages/chains-evm/dist/index.js';
import {
  BITCOIN_TESTNET,
  DOGECOIN_TESTNET,
  blockbookTransport,
  buildTransfer,
  esploraTransport,
  signAndBroadcast,
} from '../../packages/chains-utxo/dist/index.js';
import {
  SolanaRpcClient,
  compileMessage,
  httpTransport as solanaHttpTransport,
  signTransaction as signSolTransaction,
  systemTransfer,
} from '../../packages/chains-solana/dist/index.js';
import { BTC_ESPLORAS, SEPOLIA_RPC, SOLANA_DEVNET } from './config.mjs';

const mnemonic = readFileSync(
  new URL('../../.dev-wallet/mnemonic.txt', import.meta.url),
  'utf8',
).trim();

const registry = new ChainRegistry();
registry.register(evmKeyProvider);
registry.register(solanaKeyProvider);
// One provider covers every Bitcoin test network: testnet3/testnet4 and
// signet share address parameters and the SLIP-44 testnet coin type 1.
registry.register(
  createUtxoKeyProvider({
    chainId: 'bip122:btc-test',
    name: 'Bitcoin test networks',
    coinType: 1,
    purpose: 84,
    bech32Hrp: 'tb',
  }),
);
registry.register(
  createUtxoKeyProvider({
    chainId: 'bip122:dogecoin-testnet',
    name: 'Dogecoin testnet',
    coinType: 1,
    purpose: 44,
    p2pkhVersion: 0x71,
  }),
);
const keyring = HdKeyring.fromMnemonic(mnemonic, registry);

/**
 * Reads KEY=value lines from the git-ignored .dev-wallet/env file, where
 * API keys live so they can never be committed.
 */
function devEnv(name) {
  try {
    const text = readFileSync(new URL('../../.dev-wallet/env', import.meta.url), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith(name + '='));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}
const results = [];

async function sepoliaSmoke() {
  const account = keyring.getAccount('eip155:1');
  const node = new NodeClient(httpTransport(SEPOLIA_RPC));
  const balance = await node.getBalance(account.address);
  if (balance === 0n) return results.push(['Sepolia', 'skipped: unfunded']);

  const chainId = await node.chainId();
  if (chainId !== 11155111n) throw new Error(`Unexpected Sepolia chain id ${chainId}`);
  const fees = await node.suggestFees();
  const tx = {
    chainId,
    nonce: await node.getTransactionCount(account.address),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    gasLimit: 21_000n,
    to: account.address,
    value: 1_000_000_000_000n, // 0.000001 ETH to self
  };
  const signed = signEip1559(tx, account);
  const hash = await node.sendRawTransaction(signed.rawHex);
  if (hash !== signed.txHash) {
    throw new Error(`Node hash ${hash} != local ${signed.txHash}`);
  }
  // Poll for the receipt.
  const transport = httpTransport(SEPOLIA_RPC);
  for (let i = 0; i < 30; i++) {
    const receipt = await transport('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      return results.push([
        'Sepolia',
        `CONFIRMED ${hash} in block ${BigInt(receipt.blockNumber)} (status ${receipt.status})`,
      ]);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  results.push(['Sepolia', `broadcast ${hash}, receipt not seen within 2 minutes`]);
}

async function bitcoinSmoke() {
  const account = keyring.getAccount('bip122:btc-test');
  // The same address exists on every Bitcoin test network; spend wherever
  // the faucet actually delivered.
  for (const { name, url } of BTC_ESPLORAS) {
    const transport = esploraTransport(url);
    const utxos = await transport.getUtxos(account.address);
    if (utxos.length === 0) continue;

    const feeEstimates = await (await fetch(`${url}/fee-estimates`)).json();
    const feeRate = Math.max(1, Math.ceil(feeEstimates['6'] ?? 1));
    const total = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
    const built = buildTransfer({
      network: BITCOIN_TESTNET,
      fromAddress: account.address,
      utxos,
      toAddress: account.address,
      amount: total / 2n,
      feeRate,
    });
    const txid = await signAndBroadcast(built, account, transport);
    return results.push([
      name,
      `BROADCAST ${txid} (fee ${built.fee} sats @ ${feeRate} sat/vB, spent ${utxos.length} utxo(s))`,
    ]);
  }
  results.push(['Bitcoin', 'skipped: unfunded on all checked test networks']);
}

async function solanaSmoke() {
  const account = keyring.getAccount('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  const client = new SolanaRpcClient(solanaHttpTransport(SOLANA_DEVNET));
  const lamports = await client.getBalance(account.address);
  if (lamports === 0n) return results.push(['Solana devnet', 'skipped: unfunded']);

  const { blockhash } = await client.getLatestBlockhash();
  // systemTransfer and compileMessage take raw 32-byte public keys.
  const instruction = systemTransfer({
    from: account.publicKey,
    to: account.publicKey,
    lamports: 1_000n,
  });
  const message = compileMessage({
    feePayer: account.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  });
  const signed = signSolTransaction(message, [account]);
  const signature = await client.sendTransaction(signed.wireBytes);
  const status = await client.confirmTransaction(signature, { timeoutMs: 60_000 });
  results.push([
    'Solana devnet',
    `CONFIRMED ${signature} (${status.confirmationStatus ?? 'status unknown'})`,
  ]);
}

async function dogecoinSmoke() {
  const key = devEnv('NOWNODES_KEY');
  if (!key) return results.push(['Dogecoin testnet', 'skipped: no NOWNODES_KEY in .dev-wallet/env']);
  const account = keyring.getAccount('bip122:dogecoin-testnet');
  const transport = blockbookTransport('https://dogebook-testnet.nownodes.io', {
    headers: { 'api-key': key },
  });
  const utxos = await transport.getUtxos(account.address);
  if (utxos.length === 0) {
    return results.push(['Dogecoin testnet', `skipped: unfunded (${account.address})`]);
  }
  const total = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
  // Dogecoin fees are far above Bitcoin's; recent relay norms are around
  // 0.001 DOGE/kB minimum but wallets pay ~1 DOGE/kB on testnet to be
  // safe. 1000 sat/vB approximates 0.01 DOGE/kB conservatively.
  const built = buildTransfer({
    network: DOGECOIN_TESTNET,
    fromAddress: account.address,
    utxos,
    toAddress: account.address,
    amount: total / 2n,
    feeRate: 1000,
  });
  const txid = await signAndBroadcast(built, account, transport);
  results.push(['Dogecoin testnet', `BROADCAST ${txid} (fee ${built.fee} base units)`]);
}

const runs = [
  ['Sepolia', sepoliaSmoke],
  ['Bitcoin', bitcoinSmoke],
  ['Dogecoin testnet', dogecoinSmoke],
  ['Solana devnet', solanaSmoke],
];
for (const [name, run] of runs) {
  try {
    await run();
  } catch (e) {
    results.push([name, `FAILED: ${e.message}`]);
  }
}

console.log('\n=== Testnet smoke test results ===');
for (const [chain, outcome] of results) {
  console.log(`  ${chain.padEnd(16)} ${outcome}`);
}
console.log(
  '\nNote: the ERC-4337 smoke (UserOperation through a real bundler) needs a ' +
    'bundler endpoint (e.g. a Pimlico/Alchemy API key) — see docs/AA_STACK.md.',
);

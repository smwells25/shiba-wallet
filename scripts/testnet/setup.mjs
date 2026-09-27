/**
 * Testnet smoke-test setup (phase 2, task 8, step 1 of 2).
 *
 * Creates (or loads) a DEVELOPMENT-ONLY wallet, derives its testnet
 * addresses, checks their balances on live testnet infrastructure, and
 * attempts a Solana devnet airdrop automatically. Prints the funding
 * instructions for the faucets that need a human.
 *
 * The mnemonic is stored in .dev-wallet/mnemonic.txt, which is
 * git-ignored. It must only ever hold testnet funds.
 *
 * Run from the repository root after `npm run build`:
 *   node scripts/testnet/setup.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  ChainRegistry,
  HdKeyring,
  createMnemonic,
  createUtxoKeyProvider,
  evmKeyProvider,
  solanaKeyProvider,
} from '../../packages/core/dist/index.js';

const MNEMONIC_PATH = new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);

import { BTC_ESPLORAS, SEPOLIA_RPC, SOLANA_DEVNET } from './config.mjs';

/**
 * Testnet key providers. All testnets share SLIP-44 coin type 1 by
 * convention (SLIP-44 registers 1 as "Testnet (all coins)"). Bitcoin
 * signet shares testnet address parameters (HRP "tb"), per
 * bitcoin/bitcoin chainparams. Dogecoin testnet uses p2pkh version 0x71
 * per dogecoin/dogecoin chainparams (no public Esplora exists for it —
 * see the note printed below).
 */
const btcSignetProvider = createUtxoKeyProvider({
  chainId: 'bip122:signet',
  name: 'Bitcoin signet',
  coinType: 1,
  purpose: 84,
  bech32Hrp: 'tb',
});
const dogeTestnetProvider = createUtxoKeyProvider({
  chainId: 'bip122:dogecoin-testnet',
  name: 'Dogecoin testnet',
  coinType: 1,
  purpose: 44,
  p2pkhVersion: 0x71,
});

function loadOrCreateMnemonic() {
  if (existsSync(MNEMONIC_PATH)) {
    return { mnemonic: readFileSync(MNEMONIC_PATH, 'utf8').trim(), created: false };
  }
  const mnemonic = createMnemonic(128);
  writeFileSync(MNEMONIC_PATH, mnemonic + '\n', { mode: 0o600 });
  return { mnemonic, created: true };
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function main() {
  const { mnemonic, created } = loadOrCreateMnemonic();
  console.log(
    created
      ? 'Created a new DEV-ONLY wallet at .dev-wallet/mnemonic.txt (testnet funds only!)'
      : 'Loaded the dev wallet from .dev-wallet/mnemonic.txt',
  );

  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  registry.register(solanaKeyProvider);
  registry.register(btcSignetProvider);
  registry.register(dogeTestnetProvider);
  const keyring = HdKeyring.fromMnemonic(mnemonic, registry);

  const evm = keyring.getAccount('eip155:1'); // same key/address on Sepolia
  const btc = keyring.getAccount('bip122:signet');
  const doge = keyring.getAccount('bip122:dogecoin-testnet');
  const sol = keyring.getAccount('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

  console.log('\nDev wallet testnet addresses:');
  console.log(`  Sepolia ETH     ${evm.address}`);
  console.log(`  Bitcoin signet  ${btc.address}`);
  console.log(`  Dogecoin test   ${doge.address}`);
  console.log(`  Solana devnet   ${sol.address}`);

  // Balances.
  console.log('\nCurrent balances:');
  try {
    const wei = BigInt(await rpc(SEPOLIA_RPC, 'eth_getBalance', [evm.address, 'latest']));
    console.log(`  Sepolia ETH     ${wei} wei`);
  } catch (e) {
    console.log(`  Sepolia ETH     query failed: ${e.message}`);
  }
  for (const { name, url } of BTC_ESPLORAS) {
    try {
      const utxos = await (await fetch(`${url}/address/${btc.address}/utxo`)).json();
      const sats = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
      console.log(`  ${name.padEnd(16)} ${sats} sats (${utxos.length} utxos)`);
    } catch (e) {
      console.log(`  ${name.padEnd(16)} query failed: ${e.message}`);
    }
  }
  console.log('  Dogecoin test   unqueryable: no public Esplora-compatible API found');
  try {
    const lamports = (await rpc(SOLANA_DEVNET, 'getBalance', [sol.address])).value;
    console.log(`  Solana devnet   ${lamports} lamports`);

    if (lamports < 100_000_000) {
      console.log('\nRequesting a Solana devnet airdrop of 1 SOL...');
      const sig = await rpc(SOLANA_DEVNET, 'requestAirdrop', [sol.address, 1_000_000_000]);
      console.log(`  airdrop tx: ${sig} (may take a few seconds to land)`);
    }
  } catch (e) {
    console.log(`  Solana devnet   ${e.message}`);
  }

  console.log(`
Funding needed from a human (faucets require sign-in or captchas):
  1. Sepolia ETH  -> ${evm.address}
     Options: https://cloud.google.com/application/web3/faucet/ethereum/sepolia
              https://sepolia-faucet.pk910.de (proof-of-work, no login)
  2. Bitcoin signet -> ${btc.address}
     Option:  https://signetfaucet.com
  3. Dogecoin testnet -> ${doge.address}
     Note: broadcast infrastructure is also unresolved for Dogecoin testnet
     (no public Esplora-compatible API), so DOGE smoke-testing is blocked on
     infrastructure, not only on funds. Skippable for now.

Once funded, run: node scripts/testnet/smoke.mjs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

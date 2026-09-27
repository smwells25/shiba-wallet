// Exercises the app's history glue (src/wallet/history.ts) against live
// public endpoints, outside the app, via Node's native type stripping —
// exactly like scripts/check-balances.mjs. Read-only queries only. Run from
// the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-history.mjs
//
// Addresses are derived from the standard BIP-39 test mnemonic ("abandon
// ... about"), whose addresses are public knowledge. The Bitcoin address
// has rich real mainnet history, which also proves pagination: the script
// fetches page 2 through the nextCursor returned by page 1.

import { bitcoinKeyProvider, mnemonicToSeed, solanaKeyProvider } from '@shiba-wallet/core';
import { DEFAULT_NETWORKS } from '../src/config/defaults.ts';
import {
  directionLabel,
  explorerTxUrl,
  formatTimestamp,
  historySourceFor,
} from '../src/wallet/history.ts';
import { formatUnits } from '../src/wallet/balances.ts';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const seed = mnemonicToSeed(TEST_MNEMONIC);
const btc = bitcoinKeyProvider.deriveAccount(seed, 0, 0);
const sol = solanaKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);

const byChain = Object.fromEntries(DEFAULT_NETWORKS.map((n) => [n.chainId, n]));

function printEntry(entry, network, chainId) {
  const amount =
    entry.amount === undefined ? '—' : formatUnits(entry.amount, network.decimals, network.decimals);
  const fee =
    entry.fee === undefined ? '' : `  fee ${formatUnits(entry.fee, network.decimals, network.decimals)}`;
  const status = entry.failed ? 'FAILED' : entry.confirmed ? 'confirmed' : 'pending';
  console.log(
    `  ${entry.id.slice(0, 16)}…  ${directionLabel(entry.direction).padEnd(8)} ` +
      `${amount.padStart(14)} ${network.symbol}${fee}  ${status}  ` +
      `${formatTimestamp(entry.timestamp)}  ${explorerTxUrl(chainId, entry.id) ?? '(no explorer)'}`,
  );
}

let failures = 0;

// Every chain's availability state, straight from the glue.
console.log('== Availability per chain (as the Activity screen resolves it) ==');
for (const network of DEFAULT_NETWORKS) {
  const source = historySourceFor(network.kind, network.defaultUrl);
  console.log(
    `${network.label.padEnd(9)} ${source.status}` +
      (source.status === 'unavailable' ? ` — ${source.note}` : ''),
  );
}

// Bitcoin: first page, then page 2 through the cursor (pagination proof).
const btcNet = byChain['bip122:000000000019d6689c085ae165831e93'];
console.log(`\n== Bitcoin ${btc.address} via ${btcNet.defaultUrl} ==`);
try {
  const source = historySourceFor(btcNet.kind, btcNet.defaultUrl);
  if (source.status !== 'available') throw new Error('Bitcoin source should be available');
  const page1 = await source.provider.getHistory(btc.address);
  console.log(`page 1: ${page1.entries.length} entries, nextCursor=${page1.nextCursor ?? 'none'}`);
  for (const entry of page1.entries.slice(0, 5)) printEntry(entry, btcNet, btcNet.chainId);
  if (!page1.nextCursor) throw new Error('Expected a nextCursor on this well-used address');
  const page2 = await source.provider.getHistory(btc.address, page1.nextCursor);
  console.log(
    `page 2 (cursor ${page1.nextCursor.slice(0, 16)}…): ${page2.entries.length} entries, ` +
      `nextCursor=${page2.nextCursor ?? 'none'}`,
  );
  for (const entry of page2.entries.slice(0, 3)) printEntry(entry, btcNet, btcNet.chainId);
  const ids1 = new Set(page1.entries.map((e) => e.id));
  const overlap = page2.entries.filter((e) => ids1.has(e.id)).length;
  console.log(`overlap with page 1: ${overlap} entries (expected 0)`);
  if (overlap > 0) throw new Error('Pages overlap');
} catch (e) {
  failures += 1;
  console.error(`Bitcoin FAILED: ${e instanceof Error ? e.message : e}`);
}

// Solana: first page against the public mainnet RPC.
const solNet = byChain['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
console.log(`\n== Solana ${sol.address} via ${solNet.defaultUrl} ==`);
try {
  const source = historySourceFor(solNet.kind, solNet.defaultUrl);
  if (source.status !== 'available') throw new Error('Solana source should be available');
  const page = await source.provider.getHistory(sol.address);
  console.log(`page 1: ${page.entries.length} entries, nextCursor=${page.nextCursor ?? 'none'}`);
  if (page.entries.length === 0) {
    console.log('  (no transactions for this address — an honest empty state, not a failure)');
  }
  for (const entry of page.entries.slice(0, 5)) printEntry(entry, solNet, solNet.chainId);
} catch (e) {
  failures += 1;
  console.error(`Solana FAILED: ${e instanceof Error ? e.message : e}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nHistory glue checks passed.');

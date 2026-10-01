// Exercises the app's balance module (src/wallet/balances.ts) against the
// default public endpoints (src/config/defaults.ts), selected the way the
// app selects them (src/config/endpoint-probe.ts), outside the app.
//
// It imports the actual TypeScript modules the app runs, via Node's native
// type stripping (available unflagged since Node 23.6; the repo toolchain is
// Node 24). Both modules are deliberately free of React Native imports for
// exactly this reason. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-balances.mjs
//
// Addresses are derived from the standard BIP-39 test mnemonic ("abandon
// ... about"), whose addresses are public knowledge. Read-only queries only.

import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  evmKeyProvider,
  mnemonicToSeed,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import { DEFAULT_NETWORKS } from '../src/config/defaults.ts';
import { fetchNativeBalance, formatUnits } from '../src/wallet/balances.ts';
import { createDefaultEndpointResolver, describeDefaultChoice } from '../src/config/endpoint-probe.ts';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const providers = [evmKeyProvider, bitcoinKeyProvider, dogecoinKeyProvider, solanaKeyProvider];

const seed = mnemonicToSeed(TEST_MNEMONIC);
const addressByChain = new Map();
for (const provider of providers) {
  const account = provider.deriveAccount(seed, 0, 0);
  addressByChain.set(provider.chainId, account.address);
}
seed.fill(0);

let failures = 0;
const resolver = createDefaultEndpointResolver();

for (const network of DEFAULT_NETWORKS) {
  const address = addressByChain.get(network.chainId);
  const prefix = `${network.label.padEnd(9)} ${String(address).padEnd(44)}`;
  if (network.defaultUrls.length === 0) {
    console.log(`${prefix} unavailable (no default endpoint${network.note ? ': by design' : ''})`);
    continue;
  }
  try {
    // The same default selection the app makes (config/networks.ts): the
    // first candidate that passes the chain-identity probe, in order.
    const choice = await resolver.resolve(network);
    if (!choice.healthy || !choice.url) {
      throw new Error(`no healthy default endpoint (primary: ${choice.primaryFailure})`);
    }
    const amount = await fetchNativeBalance(network.kind, choice.url, address);
    console.log(
      `${prefix} ${formatUnits(amount, network.decimals, network.decimals)} ${network.symbol}` +
        `  (${amount} base units via ${choice.url}, ${describeDefaultChoice(choice)})`,
    );
  } catch (e) {
    failures += 1;
    console.error(`${prefix} FAILED: ${e instanceof Error ? e.message : e}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} chain(s) failed`);
  process.exit(1);
}
console.log('\nAll configured default endpoints answered.');

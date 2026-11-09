/**
 * Solana token-layer smoke test (phase 24 item A): Token-2022 and classic
 * SPL Token on DEVNET, through the engine's own code in
 * packages/chains-solana (tokenExtensions.ts, tokenTransfer.ts).
 *
 * Default run (read-only, nothing signed or sent):
 *   1. Confirms both devnet RPCs below answer devnet's genesis hash.
 *   2. Reads the token programs' accounts (they must be executable).
 *   3. Lists the dev wallet's token accounts under BOTH token programs.
 *   4. Reads and classifies the issuer-documented devnet mints (Circle USDC,
 *      classic; Paxos PYUSD, Token-2022) on both RPCs and checks the raw
 *      bytes agree, then prints each mint's class, decimals, extensions,
 *      metadata and notes.
 *   5. Quotes a transfer of each mint from the dev wallet to dev index 1
 *      and prints the quote or the refusal sentence.
 *
 * Live run (SPL_LIVE=1 SPL_MINT=<mint> SPL_AMOUNT=<base units>): sends the
 * quoted transfer only when the quote succeeds, with a hard cap of
 * 0.05 SOL on fee plus rent, then confirms it and re-reads the transaction
 * status on the second RPC. No airdrop, no mint creation: a live leg needs
 * the dev wallet to hold the token already (spl-fee-mint-smoke.mjs creates a
 * lab Token-2022 mint with a transfer fee and gives the dev wallet some).
 *
 * The dev mnemonic is read from the git-ignored .dev-wallet/mnemonic.txt
 * (or the file SPL_MNEMONIC_FILE names) and never printed; only public
 * addresses are printed.
 *
 * Run from the repository root after `npm run build`:
 *   node scripts/testnet/spl-token-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { mnemonicToSeed, solanaKeyProvider } from '../../packages/core/dist/index.js';
import {
  KNOWN_SOLANA_TOKENS,
  SOLANA_DEVNET_CAIP2,
  SolanaRpcClient,
  SplTokenRefusal,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  compileMessage,
  formatBaseUnits,
  httpTransport,
  listOwnerTokenAccounts,
  quoteSplTokenTransfer,
  readMintProfile,
  signTransaction,
} from '../../packages/chains-solana/dist/index.js';
import { base58 } from '@scure/base';

/**
 * Two keyless devnet endpoints, both answering devnet's genesis hash
 * EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG on 2026-11-07.
 */
const PRIMARY = 'https://api.devnet.solana.com';
const SECOND = 'https://solana-devnet.api.onfinality.io/public';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** 0.05 SOL: the most this script will ever spend on fee plus rent. */
const LAMPORT_CAP = 50_000_000n;

// SPL_MNEMONIC_FILE lets a checkout without its own .dev-wallet (a
// verification worktree) read the main checkout's file in place.
const mnemonicFile = process.env.SPL_MNEMONIC_FILE ?? new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);
const mnemonic = readFileSync(mnemonicFile, 'utf8').trim();
const seed = mnemonicToSeed(mnemonic);
const owner = solanaKeyProvider.deriveAccount(seed, 0, 0);
const recipient = solanaKeyProvider.deriveAccount(seed, 1, 0);

/**
 * Public devnet endpoints rate-limit (HTTP 429). Read-only calls are retried
 * after a pause; sendTransaction is never retried, so a transaction is
 * handed over at most once.
 */
function patient(transport) {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(method, params);
      } catch (error) {
        const limited = /\b429\b/.test(String(error?.message));
        if (!limited || method === 'sendTransaction' || attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      }
    }
  };
}
const primaryTransport = patient(httpTransport(PRIMARY));
const secondTransport = patient(httpTransport(SECOND));
const client = new SolanaRpcClient(primaryTransport);
const second = new SolanaRpcClient(secondTransport);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

for (const [name, transport] of [['primary', primaryTransport], ['second', secondTransport]]) {
  const genesis = await transport('getGenesisHash', []);
  check(genesis === DEVNET_GENESIS, `${name} RPC answers devnet's genesis hash`);
}

for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
  const id = base58.encode(program);
  const account = await client.getAccountInfoBase64(id);
  check(account !== null && account.executable, `program ${id} exists and is executable`);
}

console.log(`\nDev wallet (index 0): ${owner.address}`);
console.log(`Recipient (index 1):  ${recipient.address}`);
const lamports = await client.getBalance(owner.address);
console.log(`SOL balance: ${lamports} lamports`);
const listed = await listOwnerTokenAccounts(client, owner.address);
console.log(`Token accounts: ${listed.accounts.length} (skipped ${listed.skipped})`);
for (const a of listed.accounts) {
  console.log(`  ${a.program} ${a.address} mint ${a.account.mint} amount ${a.account.amount} ${a.isAssociated ? '(associated)' : '(not associated)'} state ${a.account.state}`);
}

for (const known of KNOWN_SOLANA_TOKENS.filter((t) => t.caip2 === SOLANA_DEVNET_CAIP2)) {
  console.log(`\n${known.symbol} ${known.mint} — ${known.source}`);
  const a = await client.getAccountInfoBase64(known.mint);
  const b = await second.getAccountInfoBase64(known.mint);
  check(a !== null && b !== null && a.owner === b.owner, 'both RPCs return the mint with the same owner');
  // Supply can move between the two reads; compare everything but the supply bytes 36..44.
  const same = a && b && a.data.length === b.data.length && a.data.every((x, i) => (i >= 36 && i < 44) || x === b.data[i]);
  check(Boolean(same), 'both RPCs return the same mint bytes (supply excepted)');
  const profile = await readMintProfile(client, known.mint);
  check(profile.program === known.program, `owned by ${known.program}`);
  check(profile.parsed.decimals === known.decimals, `decimals ${known.decimals}`);
  console.log(`  class: ${profile.classification.transferClass}`);
  console.log(`  extensions: ${profile.parsed.extensions.map((e) => `${e.name ?? 'unknown'}(${e.type})`).join(', ') || 'none'}`);
  console.log(`  metadata: ${profile.metadata ? `${profile.metadata.name} / ${profile.metadata.symbol} (${profile.metadata.source})` : profile.metadataNote}`);
  for (const note of profile.classification.notes) console.log(`  note: ${note}`);

  const amount = process.env.SPL_MINT === known.mint && process.env.SPL_AMOUNT
    ? BigInt(process.env.SPL_AMOUNT)
    : 10n ** BigInt(known.decimals) / 100n;
  try {
    const quote = await quoteSplTokenTransfer(client, {
      caip2: SOLANA_DEVNET_CAIP2,
      owner: owner.address,
      recipient: recipient.address,
      mint: known.mint,
      amount,
      expectedDecimals: known.decimals,
    });
    console.log(`  QUOTE: send ${formatBaseUnits(quote.amount, quote.decimals)}, fee withheld ${formatBaseUnits(quote.transferFee, quote.decimals)}, recipient receives ${formatBaseUnits(quote.recipientReceives, quote.decimals)}`);
    console.log(`         from ${quote.sourceAccount} to ${quote.destinationAccount}${quote.createsDestination ? ' (created)' : ''}; rent ${quote.rentLamports}, network fee ${quote.networkFeeLamports} lamports`);
    for (const note of quote.notes) console.log(`  quote note: ${note}`);
    if (process.env.SPL_LIVE === '1' && process.env.SPL_MINT === known.mint) {
      const spend = quote.rentLamports + quote.networkFeeLamports;
      if (spend > LAMPORT_CAP) throw new Error(`refused: ${spend} lamports exceeds the 0.05 SOL cap`);
      const { blockhash } = await client.getLatestBlockhash('confirmed');
      const message = compileMessage({ feePayer: owner.publicKey, recentBlockhash: blockhash, instructions: quote.instructions });
      const signed = signTransaction(message, [owner]);
      const signature = await client.sendTransaction(signed.wireBytes, { preflightCommitment: 'confirmed' });
      console.log(`  SENT ${signature}`);
      const status = await client.confirmTransaction(signature, { commitment: 'confirmed', timeoutMs: 90_000 });
      console.log(`  confirmed at slot ${status.slot}`);
      const [again] = await second.getSignatureStatuses([signature], true);
      check(again !== null && again.err === null, 'second RPC sees the transaction without error');
    }
  } catch (error) {
    if (error instanceof SplTokenRefusal) {
      console.log(`  REFUSED (${error.code}): ${error.message}`);
    } else {
      throw error;
    }
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

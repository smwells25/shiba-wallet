/**
 * A Token-2022 mint WITH A TRANSFER FEE on Solana DEVNET, created by the dev
 * wallet so that the wallet's TransferCheckedWithFee path is exercised live
 * (phase 26 item 3a). A lab asset with no value; devnet only.
 *
 * Default run (nothing sent): checks both RPCs answer devnet's genesis hash,
 * reads the dev wallet's SOL on both, reads the rent figures, and SIMULATES
 * the mint-creation transaction with a fresh, throwaway mint key.
 *
 * Live run (SPL_FEE_LIVE=1), each transaction simulated first and sent only
 * when the simulation succeeds and the spend stays under the 0.1 SOL cap:
 *   1. one transaction: CreateAccount, InitializeTransferFeeConfig (100 basis
 *      points, at most 1,000,000 base units; the dev wallet as fee-config and
 *      withdraw-withheld authority), MetadataPointer → the mint itself,
 *      InitializeMint2 (6 decimals, the dev wallet as mint authority, NO
 *      freeze authority) and the TokenMetadata initialization;
 *   2. one transaction: the dev wallet's and Account 1's associated token
 *      accounts (idempotent) and MintToChecked of 100 tokens to the dev
 *      wallet and 10 tokens to Account 1;
 *   3. 1 token from the dev wallet to Account 2 THROUGH THE ENGINE's
 *      quoteSplTokenTransfer (TransferCheckedWithFee; it also creates
 *      Account 2's associated account) — the quote's instructions compiled
 *      unchanged, the script adding only the blockhash and the signature;
 *   4. read-back: the mint through readMintProfile (parseMint, classifyMint),
 *      the engine's fee against the chain, the withheld amount in Account 2's
 *      token account (decodeTransferFeeAmount), every signature re-read with
 *      getTransaction on both RPCs, balances reconciled to the base unit.
 * A run that stops after step 1 or 2 is resumed from the git-ignored public
 * record scripts/testnet/runs/solana-fee-mint.json (no secret is in it; the
 * throwaway mint key is held in memory only and not needed after step 1).
 *
 * SPL_FEE_FIXTURE=<path> writes the mint's and the three token accounts' raw
 * bytes (base64) as a test fixture after the read-back.
 *
 * The dev mnemonic is read from the file SPL_MNEMONIC_FILE names (default:
 * the git-ignored .dev-wallet/mnemonic.txt) and never printed. Only public
 * addresses, transaction signatures and figures are printed.
 *
 * Run from the repository root after `npm run build`:
 *   node scripts/testnet/spl-fee-mint-smoke.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { mnemonicToSeed, solanaKeyProvider } from '../../packages/core/dist/index.js';
import {
  EXT,
  SOLANA_DEVNET_CAIP2,
  SolanaRpcClient,
  TOKEN_2022_PROGRAM_ID,
  associatedAccountLength,
  calculateTransferFee,
  classifyMint,
  compileMessage,
  createAssociatedTokenAccountIdempotent,
  decodeTokenMetadataExtension,
  decodeTransferFeeAmount,
  decodeTransferFeeConfig,
  findAssociatedTokenAddress,
  findExtension,
  httpTransport,
  initializeMetadataPointer,
  initializeMint2,
  initializeTokenMetadata,
  initializeTransferFeeConfig,
  mintLengthWithExtensions,
  mintToChecked,
  parseMint,
  parseTokenAccount,
  quoteSplTokenTransfer,
  readMintProfile,
  signTransaction,
  systemCreateAccount,
  tokenMetadataLength,
  transferFeeRateAt,
} from '../../packages/chains-solana/dist/index.js';

const PRIMARY = 'https://api.devnet.solana.com';
const SECOND = 'https://solana-devnet.api.onfinality.io/public';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** 0.1 SOL: the most this script will ever spend on rent plus fees, in all runs together. */
const LAMPORT_CAP = 100_000_000n;

/** The emulator wallet's devnet addresses (m/44'/501'/0'/0' and 1'/0'), read from its Receive screen in passes p24-recheck and p24-unblock. */
const ACCOUNT_1 = 'EK5jKrBRwvQXXsSERGN6jEoYaofE2PNiZWQoaCLtrYPv';
const ACCOUNT_2 = '9WMgKdmRJBZy8WQ6Q9T6VjJN4wyT9jQenDvfvLFe471n';

const DECIMALS = 6;
const FEE_BASIS_POINTS = 100;
const MAXIMUM_FEE = 1_000_000n;
const NAME = 'Shiba Fee Test';
const SYMBOL = 'SFEE';
const URI = '';
const MINT_TO_DEV = 100_000_000n;
const MINT_TO_ACCOUNT_1 = 10_000_000n;
const SEND_AMOUNT = 1_000_000n;

const RECORD = new URL('./runs/solana-fee-mint.json', import.meta.url);
const live = process.env.SPL_FEE_LIVE === '1';

const mnemonicFile = process.env.SPL_MNEMONIC_FILE ?? new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);
const dev = solanaKeyProvider.deriveAccount(mnemonicToSeed(readFileSync(mnemonicFile, 'utf8').trim()), 0, 0);

/** Read-only calls are retried on HTTP 429; sendTransaction never is. */
function patient(transport) {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(method, params);
      } catch (error) {
        const limited = /\b429\b/.test(String(error?.message));
        if (!limited || method === 'sendTransaction' || attempt >= 8) throw error;
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      }
    }
  };
}
const t1 = patient(httpTransport(PRIMARY));
const t2 = patient(httpTransport(SECOND));
const client = new SolanaRpcClient(t1);
const second = new SolanaRpcClient(t2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : { steps: {} };
const saveRecord = () => {
  mkdirSync(new URL('./runs/', import.meta.url), { recursive: true });
  writeFileSync(RECORD, `${JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
};

async function simulate(signed, label) {
  const result = await t1('simulateTransaction', [
    signed.base64,
    { encoding: 'base64', sigVerify: true, commitment: 'confirmed' },
  ]);
  const ok = result.value.err === null;
  check(ok, `${label}: simulateTransaction succeeds (${result.value.unitsConsumed} compute units)`);
  if (!ok) {
    for (const line of result.value.logs ?? []) console.log(`    log: ${line}`);
    console.log(`    err: ${JSON.stringify(result.value.err)}`);
  }
  return ok;
}

/** Spend so far in all runs (from the record), so the cap holds across resumes. */
const spentSoFar = () =>
  Object.values(record.steps).reduce((sum, step) => sum + BigInt(step.lamportsSpent ?? 0), 0n);

async function sendStep(name, instructions, signers, expectedSpend) {
  if (spentSoFar() + expectedSpend > LAMPORT_CAP) {
    throw new Error(`refused: ${name} would bring the spend to ${spentSoFar() + expectedSpend} lamports, above the 0.1 SOL cap`);
  }
  const { blockhash } = await client.getLatestBlockhash('confirmed');
  const message = compileMessage({ feePayer: dev.publicKey, recentBlockhash: blockhash, instructions });
  const signed = signTransaction(message, signers);
  if (!(await simulate(signed, name))) throw new Error(`${name}: the simulation failed; nothing was sent`);
  if (!live) return null;
  const before = await client.getBalance(dev.address, 'confirmed');
  const signature = await client.sendTransaction(signed.wireBytes, { preflightCommitment: 'confirmed' });
  console.log(`  SENT ${name}: ${signature}`);
  record.steps[name] = { signature, status: 'sent' };
  saveRecord();
  const status = await client.confirmTransaction(signature, { commitment: 'confirmed', timeoutMs: 90_000 });
  const after = await client.getBalance(dev.address, 'confirmed');
  record.steps[name] = { signature, status: 'confirmed', slot: status.slot, lamportsSpent: before - after };
  saveRecord();
  console.log(`  confirmed at slot ${status.slot}; the dev wallet's SOL ${before} → ${after} (−${before - after} lamports)`);
  return signature;
}

const pub = (s) => base58.decode(s);
const ata = (owner, mint) =>
  base58.encode(findAssociatedTokenAddress({ owner: pub(owner), mint: pub(mint), tokenProgramId: TOKEN_2022_PROGRAM_ID }).address);

// --- 0. the network and the funds -----------------------------------------
for (const [name, t] of [['primary', t1], ['second', t2]]) {
  check((await t('getGenesisHash', [])) === DEVNET_GENESIS, `${name} RPC answers devnet's genesis hash`);
}
console.log(`\nDev wallet (index 0): ${dev.address}`);
console.log(`Account 1: ${ACCOUNT_1}\nAccount 2: ${ACCOUNT_2}`);
const balances = {};
for (const address of [dev.address, ACCOUNT_1, ACCOUNT_2]) {
  const a = await client.getBalance(address, 'confirmed');
  const b = await second.getBalance(address, 'confirmed');
  balances[address] = a;
  console.log(`  ${address}: ${a} lamports (primary), ${b} (second)`);
}
const metaLength = tokenMetadataLength(NAME, SYMBOL, URI);
const mintSpace = mintLengthWithExtensions([EXT.TransferFeeConfig, EXT.MetadataPointer]);
const mintFinal = mintLengthWithExtensions([EXT.TransferFeeConfig, EXT.MetadataPointer], [metaLength]);
const mintRent = await client.getMinimumBalanceForRentExemption(mintFinal);
const mintRent2 = await second.getMinimumBalanceForRentExemption(mintFinal);
check(mintRent === mintRent2, `rent for the ${mintFinal}-byte mint agrees on both RPCs: ${mintRent} lamports`);
console.log(`  the mint is created with ${mintSpace} bytes and funded for ${mintFinal} (TokenMetadata ${metaLength} bytes added by its initialization)`);

// --- 1. the mint -----------------------------------------------------------
let mint = record.mint ?? null;
if (mint && (await client.getAccountInfoBase64(mint, 'confirmed')) !== null) {
  console.log(`\nStep 1 already done: mint ${mint}`);
} else {
  const mintSecret = ed25519.utils.randomSecretKey();
  const mintKey = { publicKey: ed25519.getPublicKey(mintSecret), sign: (m) => ed25519.sign(m, mintSecret) };
  const candidate = base58.encode(mintKey.publicKey);
  console.log(`\nStep 1: ${live ? '' : '(dry run) '}create mint ${candidate}`);
  const instructions = [
    systemCreateAccount({ from: dev.publicKey, newAccount: mintKey.publicKey, lamports: mintRent, space: BigInt(mintSpace), owner: TOKEN_2022_PROGRAM_ID }),
    initializeTransferFeeConfig({ mint: mintKey.publicKey, transferFeeConfigAuthority: dev.publicKey, withdrawWithheldAuthority: dev.publicKey, basisPoints: FEE_BASIS_POINTS, maximumFee: MAXIMUM_FEE }),
    initializeMetadataPointer({ mint: mintKey.publicKey, authority: dev.publicKey, metadataAddress: mintKey.publicKey }),
    initializeMint2({ mint: mintKey.publicKey, decimals: DECIMALS, mintAuthority: dev.publicKey, freezeAuthority: null }),
    initializeTokenMetadata({ mint: mintKey.publicKey, updateAuthority: dev.publicKey, mintAuthority: dev.publicKey, name: NAME, symbol: SYMBOL, uri: URI }),
  ];
  if (live) {
    record.mint = candidate;
    record.fee = { basisPoints: FEE_BASIS_POINTS, maximumFee: MAXIMUM_FEE, decimals: DECIMALS, name: NAME, symbol: SYMBOL };
    saveRecord();
  }
  await sendStep('create-mint', instructions, [dev, mintKey], mintRent + 10_000n);
  if (!live) {
    console.log(failures === 0 ? '\nDRY RUN PASSED (steps 2 and 3 need the mint to exist; they are simulated in the live run before each send)' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
  mint = candidate;
}

// --- 2. associated accounts and the supply --------------------------------
const devAta = ata(dev.address, mint);
const a1Ata = ata(ACCOUNT_1, mint);
const a2Ata = ata(ACCOUNT_2, mint);
const ataLength = associatedAccountLength(parseMint((await client.getAccountInfoBase64(mint, 'confirmed')).data, 'token-2022'));
const ataRent = await client.getMinimumBalanceForRentExemption(ataLength);
console.log(`  an associated account for this mint is ${ataLength} bytes (associatedAccountLength); its rent ${ataRent} lamports`);
if (record.steps['mint-to']?.status === 'confirmed') {
  console.log(`\nStep 2 already done: ${record.steps['mint-to'].signature}`);
} else {
  console.log(`\nStep 2: associated accounts ${devAta} (dev) and ${a1Ata} (Account 1); mint 100 and 10 ${SYMBOL}`);
  const mintBytes = pub(mint);
  await sendStep(
    'mint-to',
    [
      createAssociatedTokenAccountIdempotent({ payer: dev.publicKey, owner: dev.publicKey, mint: mintBytes, tokenProgramId: TOKEN_2022_PROGRAM_ID }),
      createAssociatedTokenAccountIdempotent({ payer: dev.publicKey, owner: pub(ACCOUNT_1), mint: mintBytes, tokenProgramId: TOKEN_2022_PROGRAM_ID }),
      mintToChecked({ mint: mintBytes, destination: pub(devAta), authority: dev.publicKey, amount: MINT_TO_DEV, decimals: DECIMALS }),
      mintToChecked({ mint: mintBytes, destination: pub(a1Ata), authority: dev.publicKey, amount: MINT_TO_ACCOUNT_1, decimals: DECIMALS }),
    ],
    [dev],
    2n * ataRent + 5_000n,
  );
}

// --- the mint through the engine ------------------------------------------
const profile = await readMintProfile(client, mint);
check(profile.program === 'token-2022', 'readMintProfile: owned by Token-2022');
check(profile.classification.transferClass === 'fee-charging', `classifyMint: ${profile.classification.transferClass}`);
check(profile.parsed.decimals === DECIMALS && profile.parsed.freezeAuthority === null, 'decimals 6, no freeze authority');
check(profile.parsed.mintAuthority === dev.address, 'mint authority = the dev wallet');
const feeConfig = profile.classification.transferFee;
check(
  feeConfig.transferFeeConfigAuthority === dev.address && feeConfig.withdrawWithheldAuthority === dev.address,
  'fee-config and withdraw-withheld authority = the dev wallet',
);
check(
  feeConfig.newerTransferFee.basisPoints === FEE_BASIS_POINTS && feeConfig.newerTransferFee.maximumFee === MAXIMUM_FEE,
  `fee terms read back: ${feeConfig.newerTransferFee.basisPoints} bps, max ${feeConfig.newerTransferFee.maximumFee}, from epoch ${feeConfig.newerTransferFee.epoch}`,
);
check(profile.metadata?.symbol === SYMBOL && profile.metadata?.name === NAME, `metadata: ${profile.metadata?.name} / ${profile.metadata?.symbol} (${profile.metadata?.source})`);
for (const note of profile.classification.notes) console.log(`  note: ${note}`);

// --- 3. the transfer through the engine -----------------------------------
let sendSignature = record.steps['send']?.signature ?? null;
if (record.steps['send']?.status === 'confirmed') {
  console.log(`\nStep 3 already done: ${sendSignature}`);
} else {
  console.log(`\nStep 3: 1 ${SYMBOL} from the dev wallet to Account 2 through quoteSplTokenTransfer`);
  const quote = await quoteSplTokenTransfer(client, {
    caip2: SOLANA_DEVNET_CAIP2,
    owner: dev.address,
    recipient: ACCOUNT_2,
    mint,
    amount: SEND_AMOUNT,
    expectedDecimals: DECIMALS,
    nativeSymbol: 'test SOL',
  });
  const epoch = await client.getEpoch();
  const expectedFee = calculateTransferFee(transferFeeRateAt(feeConfig, epoch), SEND_AMOUNT);
  check(quote.transferFee === expectedFee && expectedFee === 10_000n, `quote's fee ${quote.transferFee} = calculateTransferFee at epoch ${epoch} = 10,000`);
  check(quote.recipientReceives === 990_000n, `recipient receives ${quote.recipientReceives}`);
  check(quote.destinationAccount === a2Ata && quote.createsDestination, `destination ${quote.destinationAccount} created by this transaction (rent ${quote.rentLamports})`);
  const last = quote.instructions.at(-1);
  check(
    base58.encode(last.programId) === base58.encode(TOKEN_2022_PROGRAM_ID) && last.data[0] === 26 && last.data[1] === 1 && last.data.length === 19,
    'the last instruction is TransferCheckedWithFee (26, 1; 19 bytes)',
  );
  for (const note of quote.notes) console.log(`  quote note: ${note}`);
  record.quote = { fee: quote.transferFee, recipientReceives: quote.recipientReceives, rentLamports: quote.rentLamports, epoch };
  sendSignature = await sendStep('send', quote.instructions, [dev], quote.rentLamports + quote.networkFeeLamports);
}

// --- 4. read-back -----------------------------------------------------------
console.log('\nStep 4: read-back on both RPCs');
await sleep(4_000);
const rawAccounts = {};
for (const [label, address, expected, withheld] of [
  ['dev', devAta, MINT_TO_DEV - SEND_AMOUNT, 0n],
  ['Account 1', a1Ata, MINT_TO_ACCOUNT_1, 0n],
  ['Account 2', a2Ata, SEND_AMOUNT - 10_000n, 10_000n],
]) {
  for (const [rpc, c] of [['primary', client], ['second', second]]) {
    let raw = null;
    for (let i = 0; i < 10 && raw === null; i++) {
      raw = await c.getAccountInfoBase64(address, 'confirmed');
      if (raw === null) await sleep(3_000);
    }
    const parsed = parseTokenAccount(raw.data, 'token-2022');
    const fa = findExtension(parsed.extensions, EXT.TransferFeeAmount);
    const held = fa ? decodeTransferFeeAmount(fa).withheldAmount : null;
    check(
      parsed.mint === mint && parsed.amount === expected && held === withheld,
      `${rpc}: ${label}'s token account ${address} (${raw.data.length} bytes, ${raw.lamports} lamports) amount ${parsed.amount}, withheld ${held}`,
    );
    if (rpc === 'primary') rawAccounts[address] = raw;
  }
}
const mintRaw = await client.getAccountInfoBase64(mint, 'confirmed');
const mintRaw2 = await second.getAccountInfoBase64(mint, 'confirmed');
check(base64.encode(mintRaw.data) === base64.encode(mintRaw2.data), `both RPCs return the same mint bytes (${mintRaw.data.length} bytes, ${mintRaw.lamports} lamports)`);
check(mintRaw.data.length === mintFinal && mintRaw.lamports === mintRent, `the mint is ${mintFinal} bytes and holds exactly its rent`);
const parsedMint = parseMint(mintRaw.data, 'token-2022');
check(parsedMint.supply === MINT_TO_DEV + MINT_TO_ACCOUNT_1, `supply ${parsedMint.supply}`);
const metaExt = decodeTokenMetadataExtension(findExtension(parsedMint.extensions, EXT.TokenMetadata));
check(metaExt.mint === mint, 'the TokenMetadata record names this mint');
check(decodeTransferFeeConfig(findExtension(parsedMint.extensions, EXT.TransferFeeConfig)).withheldAmount === 0n, "the mint's own withheld amount is 0 (nothing harvested)");
check(classifyMint(parsedMint).transferClass === 'fee-charging', 'classifyMint on the raw bytes: fee-charging');

for (const [name, step] of Object.entries(record.steps)) {
  for (const [rpc, t] of [['primary', t1], ['second', t2]]) {
    let tx = null;
    for (let i = 0; i < 10 && tx === null; i++) {
      tx = await t('getTransaction', [step.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (tx === null) await sleep(3_000);
    }
    check(tx !== null && tx.meta.err === null && tx.slot === step.slot, `${rpc}: ${name} ${step.signature} slot ${tx?.slot}, fee ${tx?.meta.fee}, err ${JSON.stringify(tx?.meta.err)}`);
    if (rpc === 'primary') {
      step.fee = tx.meta.fee;
      const keys = tx.transaction.message.accountKeys;
      const i = keys.indexOf(dev.address);
      step.devLamports = { pre: tx.meta.preBalances[i], post: tx.meta.postBalances[i] };
      if (name === 'send') {
        const post = tx.meta.postTokenBalances.find((b) => b.owner === ACCOUNT_2 && b.mint === mint);
        check(post?.uiTokenAmount.amount === '990000', `the transaction's postTokenBalances credit Account 2 with ${post?.uiTokenAmount.amount}`);
      }
    }
  }
}
saveRecord();

const devAfter = await client.getBalance(dev.address, 'confirmed');
const devAfter2 = await second.getBalance(dev.address, 'confirmed');
const spent = Object.values(record.steps).reduce((s, x) => s + BigInt(x.devLamports.pre) - BigInt(x.devLamports.post), 0n);
const fees = Object.values(record.steps).reduce((s, x) => s + BigInt(x.fee), 0n);
const rentPaid = mintRaw.lamports + rawAccounts[devAta].lamports + rawAccounts[a1Ata].lamports + rawAccounts[a2Ata].lamports;
check(spent === fees + rentPaid, `dev wallet spent ${spent} lamports = fees ${fees} + rent ${rentPaid}`);
console.log(`  dev wallet now ${devAfter} (primary), ${devAfter2} (second)`);
if (process.env.SPL_FEE_FIXTURE) {
  const accounts = {};
  for (const raw of [mintRaw, rawAccounts[devAta], rawAccounts[a1Ata], rawAccounts[a2Ata]]) {
    accounts[raw.address] = { owner: raw.owner, lamports: Number(raw.lamports), dataBase64: base64.encode(raw.data) };
  }
  writeFileSync(
    process.env.SPL_FEE_FIXTURE,
    `${JSON.stringify({ description: `Raw getAccountInfo answers (base64, commitment confirmed) read from ${PRIMARY} on ${new Date().toISOString().slice(0, 10)}, read-only, after scripts/testnet/spl-fee-mint-smoke.mjs created the lab mint ${mint} (Token-2022, ${FEE_BASIS_POINTS} basis points, at most ${MAXIMUM_FEE} base units) and sent 1 ${SYMBOL} to Account 2.`, mint, accounts: { [mint]: accounts[mint], [devAta]: accounts[devAta], [a1Ata]: accounts[a1Ata], [a2Ata]: accounts[a2Ata] }, roles: { mint, devAta, account1Ata: a1Ata, account2Ata: a2Ata } }, null, 2)}\n`,
  );
  console.log(`  fixture written to ${process.env.SPL_FEE_FIXTURE}`);
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

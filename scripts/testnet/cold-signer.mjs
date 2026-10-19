/**
 * The OFF-LINE half of cold signing (feature 11, phase 22 item 3), for
 * proofs and emulator passes. It plays the air-gapped signer of a
 * watch-only account: it reads a request the app showed (the JSON text, or
 * the "SW-CS:n/total:" parts of its QR codes one per line), decodes and
 * prints what it asks for FROM THE TRANSACTION FIELDS (never trusting the
 * request's own summary), signs it with a dev-seed account, and prints the
 * signature payload the app scans back. Everything goes through the app's
 * own app/src/wallet/cold-signing.ts (Node type stripping), so the payloads
 * have exactly the app's format.
 *
 * It never touches the network and never prints a key or the phrase.
 *
 * Run from the repository root (Node 24; engine packages built):
 *
 *   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
 *   node scripts/testnet/cold-signer.mjs address 3
 *        print dev index 3's address (m/44'/60'/0'/0/3), to watch it in the app
 *   node scripts/testnet/cold-signer.mjs sign request.txt 3 > signature.json
 *        sign a request (a file, or - for stdin) as dev index 3; the
 *        decoded request goes to stderr, the signature payload to stdout
 *   node scripts/testnet/cold-signer.mjs qr-png signature.json outdir
 *        render a payload as the app shows QR codes (level L, one PNG per
 *        part), for the emulator camera
 *   node scripts/testnet/cold-signer.mjs selftest
 *        offline round trip with the public BIP-39 test phrase: build a
 *        request through the app's code, read it back from its QR parts in
 *        reverse order, sign, verify, compare with ethers; no network, no
 *        .dev-wallet access
 *
 * Environment: MNEMONIC_FILE (default .dev-wallet/mnemonic.txt; point it at
 * a file holding the public test phrase to rehearse without the dev seed).
 *
 * Test networks only: a request for any chain id outside TEST_CHAINS is
 * refused before anything is signed (the repository's testnets-only rule).
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { evmKeyProvider, mnemonicToSeed } = await import(pathToFileURL(join(ROOT, 'packages/core/dist/index.js')).href);
const { eip1559SigningHash } = await import(pathToFileURL(join(ROOT, 'packages/chains-evm/dist/index.js')).href);
const cs = await import(pathToFileURL(join(ROOT, 'app/src/wallet/cold-signing.ts')).href);

/** Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Hoodi, OP Sepolia (as scripts/testnet/fund.mjs). */
const TEST_CHAINS = ['11155111', '84532', '421614', '560048', '11155420'];

const PUBLIC_TEST_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function devSigner(index, phraseOverride = null) {
  const phrase = phraseOverride ?? readFileSync(process.env.MNEMONIC_FILE ?? join(ROOT, '.dev-wallet/mnemonic.txt'), 'utf8').trim();
  const seed = mnemonicToSeed(phrase);
  try {
    return evmKeyProvider.deriveAccount(seed, 0, Number(index));
  } finally {
    seed.fill(0);
  }
}

function parseIndex(text) {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(String(text ?? ''))) throw new Error('Give the dev index as a whole number (for example 3).');
  return Number(text);
}

/** The request text from a file or stdin: the JSON, or QR parts one per line (any order). */
function readRequestText(path) {
  const raw = readFileSync(path === '-' ? 0 : path, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => l.startsWith(cs.COLD_SIGN_QR_PART_PREFIX))) {
    let scan = null;
    for (const line of lines) {
      const r = cs.acceptColdSignQrScan(scan, line);
      if (r.kind === 'complete') return r.text;
      scan = r.scan;
    }
    throw new Error('Some parts of the request are missing.');
  }
  return raw.trim();
}

/** The signer's own reading of a request, from its fields only. */
function describe(request) {
  const tx = cs.coldSignTxFromRequest(request);
  const call = cs.decodeColdSignCall(tx);
  const worst = tx.gasLimit * tx.maxFeePerGas;
  const lines = [
    `chain id        ${request.chainId}`,
    `from (signer)   ${request.from}`,
    `nonce           ${tx.nonce}`,
    `gas limit       ${tx.gasLimit}`,
    `max fee         ${tx.maxFeePerGas} wei per gas (priority ${tx.maxPriorityFeePerGas})`,
    `worst-case fee  ${worst} wei (gas limit × max fee; an OP-stack L1 fee comes on top)`,
  ];
  if (call.kind === 'native') lines.push(`sends           ${call.value} wei to ${call.to}`);
  else if (call.kind === 'erc20-transfer') lines.push(`ERC-20 transfer ${call.amount} base units of token ${call.token} to ${call.recipient}`);
  else lines.push(`contract call   to ${call.to}, value ${call.value} wei, data ${call.data}`);
  lines.push(`signing hash    ${request.signingHash}`);
  lines.push(`request id      ${request.requestId}`);
  lines.push(`stated summary  ${request.summary}`);
  lines.push('                (the watch-only wallet wrote that sentence; the lines above are decoded from the fields)');
  return lines.join('\n');
}

/** Signs a parsed request with a DerivedAccount (r || s || recid from core, low s). */
function signRequest(request, account) {
  if (account.address.toLowerCase() !== request.from.toLowerCase()) {
    throw new Error(`This request is for ${request.from}, but the chosen key is ${account.address}. Nothing was signed.`);
  }
  const tx = cs.coldSignTxFromRequest(request);
  const sig = account.sign(eip1559SigningHash(tx));
  if (sig.length !== 65 || (sig[64] !== 0 && sig[64] !== 1)) throw new Error('Unexpected signature shape from the key provider.');
  return cs.buildColdSignSignature(request, account.address, { yParity: sig[64], r: sig.slice(0, 32), s: sig.slice(32, 64) });
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'address') {
  console.log(devSigner(parseIndex(args[0])).address);
} else if (cmd === 'sign') {
  if (!args[0]) throw new Error('Usage: sign <request file | -> <dev index>');
  const request = cs.parseColdSignRequest(readRequestText(args[0]));
  if (!TEST_CHAINS.includes(request.chainId)) {
    throw new Error(`Chain id ${request.chainId} is not one of the test networks this script signs for (${TEST_CHAINS.join(', ')}). Nothing was signed.`);
  }
  console.error(describe(request));
  console.log(signRequest(request, devSigner(parseIndex(args[1]))));
} else if (cmd === 'qr-png') {
  if (!args[0] || !args[1]) throw new Error('Usage: qr-png <payload file> <output directory>');
  const appRequire = createRequire(join(ROOT, 'app/package.json'));
  const QRCode = appRequire('qrcode');
  const text = readFileSync(args[0], 'utf8').trim();
  const parts = cs.splitColdSignQrParts(text);
  if (!parts) throw new Error(cs.COLD_SIGN_QR_TOO_LARGE);
  mkdirSync(args[1], { recursive: true });
  for (let i = 0; i < parts.length; i++) {
    const out = join(args[1], `cold-${i + 1}-of-${parts.length}.png`);
    await QRCode.toFile(out, parts[i], { errorCorrectionLevel: 'L', margin: 4, scale: 8 });
    console.log(out);
  }
} else if (cmd === 'selftest') {
  const { ethers } = await import('ethers');
  const signer = devSigner(0, PUBLIC_TEST_PHRASE);
  const tx = {
    chainId: 11155111n,
    nonce: 7n,
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 2_000_028n,
    gasLimit: 21_000n,
    to: '0x2222222222222222222222222222222222222222',
    value: 10_000_000_000_000n,
  };
  const summary = cs.coldSignSummary({ tx, from: signer.address, nativeSymbol: 'test ETH', fee: tx.gasLimit * tx.maxFeePerGas });
  const request = cs.buildColdSignRequest({ tx, from: signer.address, summary, requestId: '0x' + '5a'.repeat(16) });
  // Read it back from its QR parts in reverse order, as a scanner would.
  const parts = cs.splitColdSignQrParts(cs.serializeColdSignRequest(request)) ?? [];
  let scan = null;
  let joined = null;
  for (const p of [...parts].reverse()) {
    const r = cs.acceptColdSignQrScan(scan, p);
    if (r.kind === 'complete') joined = r.text;
    else scan = r.scan;
  }
  const parsed = cs.parseColdSignRequest(joined);
  console.error(describe(parsed));
  const payload = signRequest(parsed, signer);
  const verified = cs.verifyColdSignSignature(payload, request);
  // ethers' own wallet over the same public test key, as the independent reference.
  const reference = await ethers.HDNodeWallet.fromPhrase(PUBLIC_TEST_PHRASE, undefined, "m/44'/60'/0'/0/0").signTransaction({
    type: 2,
    chainId: tx.chainId,
    nonce: Number(tx.nonce),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    maxFeePerGas: tx.maxFeePerGas,
    gasLimit: tx.gasLimit,
    to: tx.to,
    value: tx.value,
  });
  const ok = verified.signed.rawHex === reference && verified.signer === signer.address;
  console.log(ok ? 'selftest: OK (request → QR parts → sign → verify; raw transaction equals ethers)' : 'selftest: MISMATCH');
  if (!ok) process.exit(1);
} else {
  console.error('Commands: address <index> | sign <request file | -> <index> | qr-png <payload file> <outdir> | selftest');
  process.exit(2);
}

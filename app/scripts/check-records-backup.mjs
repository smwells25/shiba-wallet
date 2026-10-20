// The encrypted backup of the wallet's RECORDS (feature 47; phase 22 item 4;
// src/wallet/records-backup.ts and the key derivation in
// src/wallet/storage.ts), fully offline: in-memory stores stand in for
// AsyncStorage, a fake secure store for expo-secure-store, a fake RPC for a
// network the user added. Nothing touches the network.
//
// Covered:
//  - the FILE FORMAT pinned byte for byte against an INDEPENDENT
//    implementation: the BIP-39 seed through Node's pbkdf2Sync, the key
//    through Node's hkdfSync, the envelope through Node's aes-256-gcm with
//    the header as additional data (none of @noble/@scure involved), plus a
//    literal SHA-256 of the vector file;
//  - the refusals of the whole file: not base64, a wrong magic, a truncated
//    file, a newer format version (each before any key is asked for), a
//    changed byte (ciphertext or header), another recovery phrase, a payload
//    with an extra or undeclared key;
//  - a round trip of every record kind through the REAL stores' own write
//    and read functions (contacts, notes, a network the user added, tokens
//    on two networks, a guardian recovery record, a multisig, a bridge
//    transfer, price alerts, a spending limit);
//  - the merge rule (absent records added, existing ones never
//    overwritten, a second restore changes nothing), a failed step stopping
//    the restore with earlier steps kept, a damaged document left out of an
//    export;
//  - the key derivation behind the approval gate with the real vault: one
//    prompt with a standard phrase and one with a protected phrase; zero
//    secure-store reads and no prompt for a watch-only, multi-signature or
//    imported active account; a cancelled gate reads nothing;
//  - profile isolation: an export in the decoy profile (w2) reads only w2's
//    wallet keys (and the device-wide networks), never a primary-profile
//    wallet or secret key, and holds none of the primary wallet's records;
//  - every exact string; source pins on the screen wiring;
//  - mutants (rewritten copies of the modules), each shown caught.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-records-backup.mjs

import { createCipheriv, createDecipheriv, createHash, hkdfSync, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { TEST_MNEMONIC, OWNER_0, KERNEL_ACCOUNT_0 } from './fakes-kernel.mjs';

import * as rb from '../src/wallet/records-backup.ts';
import * as storage from '../src/wallet/storage.ts';
import * as seam from '../src/wallet/store-keys.ts';
import { addContact, listContacts } from '../src/wallet/contacts.ts';
import { loadNotes, saveNote } from '../src/wallet/notes.ts';
import { addCustomNetwork, loadCustomNetworks } from '../src/wallet/custom-networks.ts';
import { addToken, listTokens } from '../src/wallet/tokens.ts';
import { loadRecoveryRecords, rebuildRecoveryRecord, saveRecoveryMetadata } from '../src/wallet/recovery.ts';
import { createMultisigRecord, listMultisigRecords } from '../src/wallet/multisig.ts';
import { BRIDGE_TRANSFERS_KEY, parseBridgeTransfers, resetBridgeTransfers } from '../src/wallet/bridge.ts';
import { WATCHABLE_ASSETS, addAlert, loadPriceAlerts, updatePriceAlerts } from '../src/wallet/price-alerts.ts';
import { NATIVE_TOKEN, listSpendingPolicies, saveSpendingPolicy } from '../src/wallet/spending-policy.ts';
import { importedAccountId, multisigAccountId, watchOnlyAccountId } from '../src/wallet/account-ids.ts';
import { NOTES_READ_ONLY_MESSAGE } from '../src/wallet/notes.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
async function caught(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = join(HERE, '..');
const read = (rel) => readFileSync(join(APP, rel), 'utf8');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** An in-memory AsyncStorage stand-in that logs every key it is asked for. */
function memStore() {
  const map = new Map();
  const reads = [];
  const writes = [];
  return {
    map,
    reads,
    writes,
    getItem: async (k) => {
      reads.push(k);
      return map.has(k) ? map.get(k) : null;
    },
    setItem: async (k, v) => {
      writes.push(k);
      map.set(k, v);
    },
    removeItem: async (k) => {
      map.delete(k);
    },
  };
}
const snapshot = (store) => JSON.stringify([...store.map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

/** A minimal expo-secure-store stand-in: protected items prompt on read and write. */
function fakeSecure() {
  const items = new Map();
  const log = [];
  const prompts = [];
  const id = (k, o) => `${o?.keychainService ?? 'default'}|${k}`;
  return {
    items,
    log,
    prompts,
    async getItemAsync(k, o) {
      log.push(['get', k]);
      const rec = items.get(id(k, o));
      if (!rec) return null;
      if (rec.auth) prompts.push(o.authenticationPrompt);
      return rec.value;
    },
    async setItemAsync(k, v, o) {
      log.push(['set', k]);
      if (o?.requireAuthentication) prompts.push(o.authenticationPrompt);
      items.set(id(k, o), { value: v, auth: !!o?.requireAuthentication });
    },
    async deleteItemAsync(k, o) {
      log.push(['delete', k]);
      items.delete(id(k, o));
    },
    canUseBiometricAuthentication: () => true,
    whenUnlockedThisDeviceOnly: 1,
  };
}

/** The approval gate as biometric.ts requireLocalAuth behaves, with counters. */
function fakeGate(vault, { cancel = false } = {}) {
  const g = { calls: 0, ordinaryPrompts: [], targets: [] };
  g.fn = async (prompt, target) => {
    g.calls += 1;
    g.targets.push(target);
    const r = await vault.openPhraseForApproval(prompt, target);
    if (r.kind === 'authenticated') return { ok: true };
    if (r.kind === 'cancelled') return { ok: false, message: 'Authentication cancelled.' };
    g.ordinaryPrompts.push(prompt);
    return cancel ? { ok: false, message: 'Authentication cancelled.' } : { ok: true };
  };
  return g;
}

const NOW_MS = Date.parse('2026-10-19T12:00:00Z');
const hex = (n) => `0x${BigInt(n).toString(16)}`;
/** A fake JSON-RPC endpoint for a network the user added (chain id, a fresh head, 12-second blocks). */
function fakeRpc(chainId) {
  const headTs = Math.floor(NOW_MS / 1000) - 6;
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const answer = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    if (body.method === 'eth_chainId') return answer(hex(chainId));
    if (body.method === 'eth_getBlockByNumber') {
      if (body.params[0] === 'latest') return answer({ number: hex(1_000_000), timestamp: hex(headTs) });
      const n = BigInt(body.params[0]);
      return answer({ number: hex(n), timestamp: hex(headTs - Number(1_000_000n - n) * 12) });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } }) };
  };
  return { fetchFn, calls };
}

// The phrases are built from fixed entropy at run time (no word list in
// this file): wallet A is the public BIP-39 test vector of fakes-kernel.mjs;
// "another phrase" comes from 0x11 × 16.
const PHRASE_A = TEST_MNEMONIC;
const PHRASE_OTHER = entropyToMnemonic(new Uint8Array(16).fill(0x11), wordlist);
/** The BIP-39 seed by Node's own PBKDF2 (BIP-39: salt "mnemonic" + passphrase, 2048 rounds, SHA-512, 64 bytes). */
const nodeSeed = (phrase) => new Uint8Array(pbkdf2Sync(Buffer.from(phrase.normalize('NFKD'), 'utf8'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512'));
const SEED_A = nodeSeed(PHRASE_A);
const SEED_OTHER = nodeSeed(PHRASE_OTHER);
/** The key by Node's own HKDF (RFC 5869, SHA-256). */
const nodeKey = (seed, salt) => new Uint8Array(hkdfSync('sha256', seed, salt, Buffer.from(storage.RECORDS_BACKUP_HKDF_INFO, 'utf8'), 32));
const deriverFor = (seed, counter) => async (salt) => {
  if (counter) counter.calls += 1;
  return nodeKey(seed, salt);
};

const SEPOLIA = 'eip155:11155111';
const MAINNET = 'eip155:1';
const AMOY = 'eip155:80002';
const AMOY_INPUT = {
  name: 'Polygon Amoy',
  chainId: '80002',
  rpcUrl: 'https://rpc.amoy.example',
  nativeSymbol: 'POL',
  nativeDecimals: '18',
  explorerUrl: 'https://amoy.explorer.example',
  testnet: true,
};
const seedA = mnemonicToSeed(PHRASE_A);
const S0 = evmKeyProvider.deriveAccount(seedA, 0, 0);
const S5 = evmKeyProvider.deriveAccount(seedA, 0, 5);
const S6 = evmKeyProvider.deriveAccount(seedA, 0, 6);
seedA.fill(0);
const OWN_ACCOUNTS = [{ name: 'Account 1', address: S0.address, kind: 'phrase' }];
const addr = (byte) => ethers.getAddress('0x' + byte.repeat(20));
const TX_A = '0x' + 'ab'.repeat(32);
const OP_B = '0x' + 'cd'.repeat(32);
const erc20 = (chainId, reference, symbol) => ({
  kind: 'fungible',
  symbol,
  name: `${symbol} test`,
  decimals: 6,
  assetId: { chainId, namespace: 'erc20', reference },
});
const BRIDGE_RECORD = {
  id: 'bridge-1791900000000-1',
  providerId: 'layerzero-stargate',
  providerLabel: 'LayerZero (Stargate)',
  route: {
    providerId: 'layerzero-stargate',
    sourceChainId: 11155111,
    destinationChainId: 11155420,
    sourceAsset: { kind: 'native', symbol: 'ETH', decimals: 18 },
    destinationAsset: { kind: 'native', symbol: 'ETH', decimals: 18 },
  },
  sourceCaip2: SEPOLIA,
  sourceLabel: 'Ethereum Sepolia',
  destinationCaip2: 'eip155:11155420',
  destinationLabel: 'OP Sepolia',
  amountIn: '200000000000000',
  recipient: OWNER_0,
  sender: OWNER_0,
  senderKind: 'regular',
  sourceTxHash: '0x' + '1e'.repeat(32),
  userOpHash: null,
  destinationFromBlock: '50120000',
  sentAt: 1_791_900_000_000,
  retryTxHash: null,
  final: { state: 'delivered', detail: 'Delivered on OP Sepolia.', destinationTxHash: '0x' + 'd1'.repeat(32), checkedAt: 1_791_900_090_000 },
};
const ASSET_ETH = WATCHABLE_ASSETS[0].id;
const ASSET_SECOND = WATCHABLE_ASSETS[1].id;
const SCOPE = { chain: SEPOLIA, owner: OWNER_0 };

/** Fills `store` with one or more records of every kind, each through its own module. */
async function populate(store) {
  await addCustomNetwork(AMOY_INPUT, { store, fetchFn: fakeRpc(80002).fetchFn, now: () => NOW_MS, clock: () => new Date(NOW_MS - 1000) });
  await addContact(MAINNET, 'Alice', addr('a1'), { store, now: () => new Date('2026-01-01T00:00:00Z') });
  await addContact(SEPOLIA, 'Bob', addr('b2'), { store, now: () => new Date('2026-01-02T00:00:00Z') });
  await addContact(AMOY, 'Carol', addr('c3'), { store, now: () => new Date('2026-01-03T00:00:00Z') });
  await addToken(erc20(SEPOLIA, addr('5e'), 'TST'), store);
  await addToken(erc20(AMOY, addr('a0'), 'AMY'), store);
  await saveNote(SEPOLIA, { txid: TX_A }, 'rent for October', { store, now: () => new Date('2026-02-01T00:00:00Z') });
  await saveNote(AMOY, { userOpHash: OP_B }, 'smart-account top-up', { store, now: () => new Date('2026-02-02T00:00:00Z') });
  const meta = rebuildRecoveryRecord({ chainId: 11155111n, account: KERNEL_ACCOUNT_0, originalOwner: OWNER_0, index: 0, recordedAt: 1 });
  await saveRecoveryMetadata(meta, store, { now: 5 });
  await createMultisigRecord(
    {
      chain: SEPOLIA,
      config: { signers: [S0, S5, S6].map((s) => ({ address: s.address, weight: 1 })), threshold: 2, delaySeconds: 0 },
      localSigner: S0.address,
      name: 'Team vault',
      now: 7,
    },
    store,
  );
  await seam.writeStoreItem(store, BRIDGE_TRANSFERS_KEY, JSON.stringify({ version: 1, records: [BRIDGE_RECORD] }));
  await updatePriceAlerts((book) => {
    const one = addAlert(book, { assetId: ASSET_ETH, direction: 'above', threshold: '3000', quote: null, nowMs: 11 });
    const two = addAlert(one.book, { assetId: ASSET_ETH, direction: 'below', threshold: '2000', quote: null, nowMs: 12 });
    const tripped = {
      ...two.book,
      watchlist: [...two.book.watchlist, ASSET_SECOND],
      alerts: two.book.alerts.map((a) => (a.direction === 'below' ? { ...a, state: 'tripped', firedAt: 13, firedPrice: '1999.5' } : a)),
    };
    return { book: tripped, result: null };
  }, store);
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, cap: 10n ** 17n, windowSeconds: 86_400 }, [NATIVE_TOKEN], {
    store,
    now: 1_791_000_000,
  });
}

/** Everything a restore should bring back, read through the stores' own readers. */
async function contents(store) {
  const contacts = [];
  for (const n of [MAINNET, SEPOLIA, AMOY]) contacts.push(...(await listContacts(n, store)).map((c) => `${c.networkId}|${c.name}|${c.address}|${c.createdAt}`));
  const notes = (await loadNotes(store)).notes.map((n) => `${n.network}|${n.txid}|${n.userOpHash}|${n.text}|${n.updatedAt}`).sort();
  const networks = (await loadCustomNetworks(store)).networks.map((n) => JSON.stringify(n));
  const tokens = [...(await listTokens(SEPOLIA, store)), ...(await listTokens(AMOY, store))].map((t) => `${t.assetId.chainId}|${t.assetId.reference}|${t.symbol}`).sort();
  const recovery = (await loadRecoveryRecords(store)).entries.map((e) => `${e.metadata.chainId}|${e.metadata.account}|${e.updatedAt}`);
  const multisig = (await listMultisigRecords(undefined, store)).map((r) => `${r.chain}|${r.address}|${r.name}|${r.threshold}|${r.signers.map((s) => s.address).join(',')}`);
  const bridgeDoc = await seam.readStoreItem(store, BRIDGE_TRANSFERS_KEY);
  const bridge = parseBridgeTransfers(bridgeDoc).records.map((r) => `${r.id}|${r.amountIn}|${r.sourceTxHash}|${r.status?.state}`);
  const book = await loadPriceAlerts(store);
  const alerts = [
    `watch:${[...book.watchlist].sort().join(',')}`,
    ...book.alerts.map((a) => `${a.assetId}|${a.direction}|${a.threshold}|${a.state}|${a.createdAt}|${a.firedAt ?? ''}|${a.firedPrice ?? ''}`).sort(),
  ];
  const limits = (await listSpendingPolicies(SCOPE, store)).policies.map((p) => `${p.token}|${p.cap}|${p.windowSeconds}|${p.createdAt}|${p.allowOverride}|${p.countFees}`);
  return { contacts, notes, networks, tokens, recovery, multisig, bridge, alerts, limits };
}

const amoyRpc = fakeRpc(80002);
const verifyNetwork = { fetchFn: amoyRpc.fetchFn, now: () => NOW_MS };

// ---------------------------------------------------------------------------
console.log('The file format, against an independent implementation (Node crypto)');
// ---------------------------------------------------------------------------
const SALT = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => 0x80 + i);
const VECTOR_PLAINTEXT = '{"type":"shiba-wallet-records-backup","version":1}';
{
  check('the BIP-39 seed of the app (core mnemonicToSeed) equals Node pbkdf2Sync', Buffer.from(mnemonicToSeed(PHRASE_A)).equals(Buffer.from(SEED_A)));
  const key = storage.recordsBackupKeyFromSeed(SEED_A, SALT);
  check('the HKDF info string is exactly "shiba-wallet/records-backup/v1/aes-256-gcm-key"', storage.RECORDS_BACKUP_HKDF_INFO === 'shiba-wallet/records-backup/v1/aes-256-gcm-key');
  check('the key (HKDF-SHA256, seed as ikm, the file salt, 32 bytes) equals Node hkdfSync', Buffer.from(key).equals(Buffer.from(nodeKey(SEED_A, SALT))));
  check('the key is 32 bytes', key.length === 32 && storage.RECORDS_BACKUP_KEY_BYTES === 32 && storage.RECORDS_BACKUP_SALT_BYTES === 32);
  check('another salt gives another key', !Buffer.from(storage.recordsBackupKeyFromSeed(SEED_A, SALT.map((b) => b ^ 1))).equals(Buffer.from(key)));
  check('a non-64-byte seed is refused', (await caught(() => storage.recordsBackupKeyFromSeed(new Uint8Array(32), SALT))) !== null);

  const header = Buffer.concat([Buffer.from('SWRB', 'ascii'), Buffer.from([1]), Buffer.from(SALT), Buffer.from(NONCE)]);
  check('the header is magic "SWRB" (53 57 52 42), version 01, salt, nonce: 49 bytes',
    Buffer.from(rb.recordsBackupHeader(SALT, NONCE)).equals(header) && header.subarray(0, 5).toString('hex') === '5357524201' && rb.RECORDS_BACKUP_HEADER_BYTES === 49);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(nodeKey(SEED_A, SALT)), Buffer.from(NONCE));
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(Buffer.from(VECTOR_PLAINTEXT, 'utf8')), cipher.final()]);
  const expected = Buffer.concat([header, ct, cipher.getAuthTag()]);
  const sealed = rb.sealRecordsBackup(new TextEncoder().encode(VECTOR_PLAINTEXT), key, SALT, NONCE);
  check('the sealed bytes equal Node aes-256-gcm over the payload with the header as additional data, tag last', Buffer.from(sealed).equals(expected),
    `${Buffer.from(sealed).toString('hex').slice(0, 40)}… vs ${expected.toString('hex').slice(0, 40)}…`);
  check('the file text is RFC 4648 base64 (padded) of those bytes', Buffer.from(sealed).toString('base64') === expected.toString('base64'));
  check('the length is 49 + payload + 16', sealed.length === 49 + Buffer.byteLength(VECTOR_PLAINTEXT) + 16);
  // A literal pin of the whole vector file (SHA-256 of its base64 text).
  const vectorSha = createHash('sha256').update(expected.toString('base64')).digest('hex');
  check('the vector file is pinned (SHA-256 of its text)', vectorSha === 'b8b11837ad8ae2a84aefb56d5b1c850a21159f8e9c24ec4aafa283cd43a40db9', vectorSha);
  // Node opens what the module seals, and the module opens what Node seals.
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(nodeKey(SEED_A, SALT)), Buffer.from(NONCE));
  decipher.setAAD(header);
  decipher.setAuthTag(Buffer.from(sealed.slice(sealed.length - 16)));
  const opened = Buffer.concat([decipher.update(Buffer.from(sealed.slice(49, sealed.length - 16))), decipher.final()]).toString('utf8');
  check('Node opens the module\'s file', opened === VECTOR_PLAINTEXT);
  const env = rb.parseRecordsBackupFile(expected.toString('base64'));
  check('the module opens Node\'s file', new TextDecoder().decode(rb.openRecordsBackup(env, key)) === VECTOR_PLAINTEXT);
  check('surrounding white space (a trailing newline) is ignored', rb.parseRecordsBackupFile(`\n ${expected.toString('base64')}\n`).sealed.length === env.sealed.length);
  check('file constants: text/plain, public.plain-text, its own export directory, a dated .txt name',
    rb.RECORDS_BACKUP_MIME_TYPE === 'text/plain' && rb.RECORDS_BACKUP_UTI === 'public.plain-text' && rb.RECORDS_BACKUP_DIRECTORY === 'records-backup-export' &&
      rb.recordsBackupFileName(new Date('2026-10-19T23:59:59Z')) === 'shiba-records-backup_2026-10-19.txt');
}

// ---------------------------------------------------------------------------
console.log('Refusals of the whole file');
// ---------------------------------------------------------------------------
const VECTOR_FILE = Buffer.from(rb.sealRecordsBackup(new TextEncoder().encode(VECTOR_PLAINTEXT), nodeKey(SEED_A, SALT), SALT, NONCE));
const asText = (bytes) => Buffer.from(bytes).toString('base64');
{
  const reason = async (text, deriveKey) => {
    const e = await caught(() => rb.importRecordsBackup({ text, deriveKey, context: { store: memStore(), ownAccounts: [] } }));
    return e;
  };
  const counter = { calls: 0 };
  for (const [name, text] of [
    ['an empty file', ''],
    ['text that is not base64', 'hello, this is not a backup'],
    ['a JSON file', '{"type":"shiba-wallet-records-backup"}'],
    ['a wrong magic', asText(Buffer.concat([Buffer.from('SWRX'), VECTOR_FILE.subarray(4)]))],
    ['a truncated file (the first 60 characters)', asText(VECTOR_FILE).slice(0, 60)],
    ['a file cut inside the tag (header + 15 bytes)', asText(VECTOR_FILE.subarray(0, 49 + 15))],
    ['version 0', asText(Buffer.concat([VECTOR_FILE.subarray(0, 4), Buffer.from([0]), VECTOR_FILE.subarray(5)]))],
  ]) {
    const e = await reason(text, deriverFor(SEED_A, counter));
    check(`${name} → "not a backup", before any key is asked for`, e?.message === rb.RECORDS_BACKUP_NOT_A_BACKUP && e?.reason === 'not-a-backup' && counter.calls === 0, e?.message);
  }
  const v2 = await reason(asText(Buffer.concat([VECTOR_FILE.subarray(0, 4), Buffer.from([2]), VECTOR_FILE.subarray(5)])), deriverFor(SEED_A, counter));
  check('a newer format version (2) → its own sentence, before any key is asked for',
    v2?.reason === 'newer-format' && v2?.message === rb.recordsBackupNewerFormatMessage(2) && counter.calls === 0, v2?.message);
  const other = await reason(asText(VECTOR_FILE), deriverFor(SEED_OTHER, counter));
  check('another recovery phrase → "made by a different recovery phrase, or the file is damaged" (one key asked for)',
    other?.reason === 'wrong-phrase' && other?.message === rb.RECORDS_BACKUP_WRONG_PHRASE && counter.calls === 1, other?.message);
  const flippedCt = Buffer.from(VECTOR_FILE);
  flippedCt[60] ^= 0x01;
  check('one changed ciphertext byte → the same sentence', (await reason(asText(flippedCt), deriverFor(SEED_A)))?.message === rb.RECORDS_BACKUP_WRONG_PHRASE);
  const flippedTag = Buffer.from(VECTOR_FILE);
  flippedTag[flippedTag.length - 1] ^= 0x80;
  check('a damaged tag → the same sentence', (await reason(asText(flippedTag), deriverFor(SEED_A)))?.message === rb.RECORDS_BACKUP_WRONG_PHRASE);
  const flippedNonce = Buffer.from(VECTOR_FILE);
  flippedNonce[40] ^= 0x01;
  check('a changed nonce in the header → the same sentence (the header is authenticated)', (await reason(asText(flippedNonce), deriverFor(SEED_A)))?.message === rb.RECORDS_BACKUP_WRONG_PHRASE);
  const flippedSalt = Buffer.from(VECTOR_FILE);
  flippedSalt[6] ^= 0x01;
  check('a changed salt → the same sentence (another key)', (await reason(asText(flippedSalt), deriverFor(SEED_A)))?.message === rb.RECORDS_BACKUP_WRONG_PHRASE);

  // Payload strictness: sealed correctly, but not the expected shape.
  const sealPayload = (obj) => asText(rb.sealRecordsBackup(new TextEncoder().encode(typeof obj === 'string' ? obj : JSON.stringify(obj)), nodeKey(SEED_A, SALT), SALT, NONCE));
  const good = { type: rb.RECORDS_BACKUP_PAYLOAD_TYPE, version: 1, createdAt: '2026-10-19T12:00:00.000Z', documents: {} };
  for (const [name, obj] of [
    ['an extra top-level key', { ...good, extra: 1 }],
    ['another type', { ...good, type: 'something-else' }],
    ['another payload version', { ...good, version: 2 }],
    ['a document under a SECRET key (the recovery phrase)', { ...good, documents: { 'shiba-wallet.mnemonic.v1': 'x' } }],
    ['a document under an undeclared key', { ...good, documents: { 'shiba-wallet.whatever.v1': 'x' } }],
    ['a document under a wallet key that is not a record kind (session keys)', { ...good, documents: { 'shiba-wallet.sessions.v1': '{}' } }],
    ['a document that is not text', { ...good, documents: { 'shiba-wallet.contacts.v1': { version: 1 } } }],
    ['not JSON', 'not json at all'],
  ]) {
    const e = await reason(sealPayload(obj), deriverFor(SEED_A));
    check(`a payload with ${name} → "contents are not in the expected form"`, e?.reason === 'bad-contents' && e?.message === rb.RECORDS_BACKUP_BAD_CONTENTS, e?.message);
  }
  const empty = await rb.importRecordsBackup({ text: sealPayload(good), deriveKey: deriverFor(SEED_A), context: { store: memStore(), ownAccounts: [] } });
  check('a well-formed payload with no documents restores nothing and says so',
    empty.kinds.length === 0 && rb.describeRecordsImport(empty)[0] === 'The backup held no records, so nothing was restored.');
}

// ---------------------------------------------------------------------------
console.log('Round trip of every record kind through the real stores');
// ---------------------------------------------------------------------------
const A = memStore();
await populate(A);
const contentsA = await contents(A);
let exported;
{
  check('the source store holds every kind (fixtures took effect)',
    contentsA.contacts.length === 3 && contentsA.notes.length === 2 && contentsA.networks.length === 1 && contentsA.tokens.length === 4 &&
      contentsA.recovery.length === 1 && contentsA.multisig.length === 1 && contentsA.bridge.length === 1 && contentsA.alerts.length === 3 &&
      contentsA.limits.length === 1, JSON.stringify(contentsA));
  const randoms = [SALT, NONCE];
  const counter = { calls: 0 };
  const before = snapshot(A);
  exported = await rb.exportRecordsBackup({
    store: A,
    deriveKey: deriverFor(SEED_A, counter),
    now: () => new Date(NOW_MS),
    random: (n) => {
      const next = randoms.shift();
      if (!next || next.length !== n) throw new Error('unexpected random request');
      return next;
    },
  });
  check('the export asks for the key exactly once and writes nothing', counter.calls === 1 && snapshot(A) === before);
  const env = rb.parseRecordsBackupFile(exported.text);
  check('the export uses the salt and nonce it drew (the header)', Buffer.from(env.salt).equals(Buffer.from(SALT)) && Buffer.from(env.nonce).equals(Buffer.from(NONCE)));
  // Open it with Node (independent): the payload is exactly the stored documents.
  const header = Buffer.from(env.header);
  const d = createDecipheriv('aes-256-gcm', Buffer.from(nodeKey(SEED_A, SALT)), Buffer.from(NONCE));
  d.setAAD(header);
  d.setAuthTag(Buffer.from(env.sealed.slice(env.sealed.length - 16)));
  const payload = JSON.parse(Buffer.concat([d.update(Buffer.from(env.sealed.slice(0, env.sealed.length - 16))), d.final()]).toString('utf8'));
  check('the payload has exactly type, version, createdAt and documents', Object.keys(payload).sort().join(',') === 'createdAt,documents,type,version' &&
    payload.type === 'shiba-wallet-records-backup' && payload.version === 1 && payload.createdAt === new Date(NOW_MS).toISOString());
  const docKeys = Object.keys(payload.documents).sort();
  const expectedKeys = [
    'shiba-wallet.bridge-transfers.v1', 'shiba-wallet.contacts.v1', 'shiba-wallet.custom-networks.v1', 'shiba-wallet.multisig.v1',
    'shiba-wallet.price-alerts.v1', 'shiba-wallet.recovery-records.v1', 'shiba-wallet.spending-policies.v1',
    'shiba-wallet.tokens.v1.eip155:11155111', 'shiba-wallet.tokens.v1.eip155:80002', 'shiba-wallet.tx-notes.v1',
  ].sort();
  check('the documents are exactly the ten stored record documents', JSON.stringify(docKeys) === JSON.stringify(expectedKeys), docKeys.join(' '));
  check('…each byte for byte as stored', docKeys.every((k) => payload.documents[k] === A.map.get(k)));
  check('…none of them is a secret-scope key, and none is a key or PIN record',
    docKeys.every((k) => seam.storeKeyScope(k) !== 'secret') && !JSON.stringify(payload).includes('mnemonic') && !JSON.stringify(payload).includes('app-lock'));
  const byKind = Object.fromEntries(exported.summary.map((s) => [s.kind, s.records]));
  check('the export summary counts every kind (Sepolia\'s stored list holds its two default tokens and the added one)',
    byKind.contacts === 3 && byKind.notes === 2 && byKind['custom-networks'] === 1 && byKind.tokens === 4 && byKind['recovery-records'] === 1 &&
      byKind.multisig === 1 && byKind['bridge-transfers'] === 1 && byKind['price-alerts'] === 4 && byKind['spending-limits'] === 1 && exported.total === 18,
    JSON.stringify(byKind));
  // Pass p22b: "Backed up 28 records" was shown after the share sheet was
  // cancelled; shareAsync resolves either way, so the line says only that
  // the file was prepared and handed to the sheet.
  check('the export summary sentence (p22b: prepared and handed to the share sheet; whether it was saved is not known)', rb.describeRecordsExport(exported) ===
    'A backup of 18 records was prepared and handed to the share sheet (Networks you added: 1; Contacts: 3; Tracked tokens: 4; Transaction notes: 2; Guardian recovery records: 1; ' +
      'Multi-signature accounts: 1; Bridge transfers: 1; Price alerts and followed prices: 4; Spending limits: 1). Whether it was saved depends on what you chose there; this wallet cannot tell.', rb.describeRecordsExport(exported));
  check('…never "Backed up" (the wallet cannot tell whether the file was saved)', !/Backed up/.test(rb.describeRecordsExport(exported)) &&
    rb.describeRecordsExport({ summary: [], total: 1 }) === 'A backup of 1 record was prepared and handed to the share sheet. Whether it was saved depends on what you chose there; this wallet cannot tell.');
  {
    // The fact behind the wording, read from the installed expo-sharing.
    const kt = readFileSync(join(APP, 'node_modules/expo-sharing/android/src/main/java/expo/modules/sharing/SharingModule.kt'), 'utf8');
    check('…because expo-sharing resolves shareAsync on ANY activity result (Android: OnActivityResult resolves null without reading the result code)',
      /OnActivityResult \{ _, \(requestCode\) ->\s*if \(requestCode == REQUEST_CODE && pendingPromise != null\) \{\s*pendingPromise\?\.resolve\(null\)/.test(kt));
  }
  check('the file name carries the date only', exported.fileName === 'shiba-records-backup_2026-10-19.txt');

  // Restore on a fresh phone (same phrase).
  await resetBridgeTransfers();
  const B = memStore();
  const counterB = { calls: 0 };
  const rpcCallsBefore = amoyRpc.calls.length;
  const report = await rb.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A, counterB), context: { store: B, ownAccounts: OWN_ACCOUNTS, verifyNetwork } });
  const rpcCalls = amoyRpc.calls.slice(rpcCallsBefore);
  const added = Object.fromEntries(report.kinds.map((k) => [k.kind, k.added]));
  check('the restore asks for the key exactly once', counterB.calls === 1);
  const here = Object.fromEntries(report.kinds.map((k) => [k.kind, k.alreadyHere]));
  check('every kind is restored in order, nothing refused, nothing stopped',
    report.stoppedAt === null && report.kinds.map((k) => k.kind).join(',') === rb.RECORD_KIND_ORDER.join(',') &&
      report.kinds.every((k) => k.notRestored === 0 && k.failure === null), JSON.stringify(report));
  check('…the only records "already here" on a fresh phone are Sepolia\'s two default tokens', Object.entries(here).every(([kind, n]) => n === (kind === 'tokens' ? 2 : 0)), JSON.stringify(here));
  check('…with the expected counts', added.contacts === 3 && added.notes === 2 && added['custom-networks'] === 1 && added.tokens === 2 &&
    added['recovery-records'] === 1 && added.multisig === 1 && added['bridge-transfers'] === 1 && added['price-alerts'] === 4 && added['spending-limits'] === 1,
  JSON.stringify(added));
  const contentsB = await contents(B);
  for (const kind of Object.keys(contentsA)) {
    check(`restored ${kind} read back equal to the original (through the store's own reader)`, JSON.stringify(contentsB[kind]) === JSON.stringify(contentsA[kind]),
      `${JSON.stringify(contentsB[kind])} vs ${JSON.stringify(contentsA[kind])}`);
  }
  check('the restored network was verified again through its RPC address (chain id, then the head)', rpcCalls[0] === 'eth_chainId' && rpcCalls.includes('eth_getBlockByNumber'), JSON.stringify(rpcCalls));
  check('the report sentences', JSON.stringify(rb.describeRecordsImport(report).slice(0, 2)) ===
    JSON.stringify(['Networks you added: 1 added, 0 already on this phone.', 'Contacts: 3 added, 0 already on this phone.']), JSON.stringify(rb.describeRecordsImport(report)));

  // The merge rule: a second restore adds nothing and writes nothing.
  const beforeSecond = snapshot(B);
  const again = await rb.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A), context: { store: B, ownAccounts: OWN_ACCOUNTS, verifyNetwork } });
  check('a second restore adds nothing: every record is "already on this phone"',
    again.kinds.every((k) => k.added === 0 && k.notRestored === 0) && again.kinds.reduce((n, k) => n + k.alreadyHere, 0) === 18, JSON.stringify(again.kinds));
  check('…and leaves the stored data byte for byte as it was', snapshot(B) === beforeSecond);

  // The wrong phrase on a fresh phone: refused, nothing written.
  const W = memStore();
  const wrong = await caught(() => rb.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_OTHER), context: { store: W, ownAccounts: OWN_ACCOUNTS, verifyNetwork } }));
  check('a restore with another recovery phrase is refused and writes nothing', wrong?.message === rb.RECORDS_BACKUP_WRONG_PHRASE && W.map.size === 0);
}

// ---------------------------------------------------------------------------
console.log('The merge rule: existing records are never overwritten');
// ---------------------------------------------------------------------------
{
  await resetBridgeTransfers();
  const C = memStore();
  await addContact(MAINNET, 'Alice at work', addr('a1'), { store: C });
  await saveNote(SEPOLIA, { txid: TX_A }, 'my own text', { store: C, now: () => new Date('2026-03-01T00:00:00Z') });
  await updatePriceAlerts((book) => ({ book: addAlert(book, { assetId: ASSET_ETH, direction: 'above', threshold: '3000', quote: null, nowMs: 99 }).book, result: null }), C);
  const report = await rb.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A), context: { store: C, ownAccounts: OWN_ACCOUNTS, verifyNetwork } });
  const k = Object.fromEntries(report.kinds.map((r) => [r.kind, r]));
  const alice = (await listContacts(MAINNET, C)).find((c) => c.address === addr('a1'));
  check('a contact with the same address keeps this phone\'s name ("Alice at work"), counted as already here',
    alice?.name === 'Alice at work' && k.contacts.alreadyHere === 1 && k.contacts.added === 2);
  const note = (await loadNotes(C)).notes.find((n) => n.txid === TX_A);
  check('a note for the same transaction keeps this phone\'s text and time', note?.text === 'my own text' && note?.updatedAt === '2026-03-01T00:00:00.000Z' && k.notes.alreadyHere === 1 && k.notes.added === 1);
  const above = (await loadPriceAlerts(C)).alerts.filter((a) => a.direction === 'above' && a.threshold === '3000');
  check('the same price alert is not doubled and keeps its own creation time', above.length === 1 && above[0].createdAt === 99);
  const tripped = (await loadPriceAlerts(C)).alerts.find((a) => a.direction === 'below');
  check('a restored alert keeps its state (tripped stays tripped, with its firing)', tripped?.state === 'tripped' && tripped?.firedPrice === '1999.5' && tripped?.firedAt === 13);

  // A multisig with none of this wallet's phrase accounts as signer: refused with the store's own sentence.
  await resetBridgeTransfers();
  const D = memStore();
  const rep = await rb.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A), context: { store: D, ownAccounts: [], verifyNetwork } });
  const ms = rep.kinds.find((r) => r.kind === 'multisig');
  check('a multisig without one of this wallet\'s phrase accounts as signer is not restored, with the store\'s sentence',
    ms.added === 0 && ms.notRestored === 1 && ms.reasons[0].startsWith('None of this wallet’s recovery-phrase accounts is a signer of this multisig'), JSON.stringify(ms));

  // A network that fails verification: not restored; its tokens and contacts are refused by their own checks.
  await resetBridgeTransfers();
  const E = memStore();
  const offline = { fetchFn: async () => { throw new Error('offline'); }, now: () => NOW_MS };
  const rep2 = await rb.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A), context: { store: E, ownAccounts: OWN_ACCOUNTS, verifyNetwork: offline } });
  const net = rep2.kinds.find((r) => r.kind === 'custom-networks');
  const tok = rep2.kinds.find((r) => r.kind === 'tokens');
  const con = rep2.kinds.find((r) => r.kind === 'contacts');
  check('a network whose RPC cannot be reached is not restored (the verification sentence is the reason)',
    net.added === 0 && net.notRestored === 1 && net.reasons[0].includes('offline'), JSON.stringify(net));
  check('…its token is refused because its network is not on this phone; the other network\'s token is restored',
    tok.added === 1 && tok.notRestored === 1 && tok.reasons[0] === rb.TOKEN_NETWORK_MISSING_REASON, JSON.stringify(tok));
  check('…its contact is refused by the contacts checks; the others are restored', con.added === 2 && con.notRestored === 1, JSON.stringify(con));
}

// ---------------------------------------------------------------------------
console.log('A failed step stops the restore; earlier steps stay');
// ---------------------------------------------------------------------------
{
  await resetBridgeTransfers();
  const F = memStore();
  await seam.writeStoreItem(F, seam.STORE_KEYS.txNotes.name, '{"version":1,"networks":{"eip155:1":{"bad":1}}}');
  const report = await rb.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A), context: { store: F, ownAccounts: OWN_ACCOUNTS, verifyNetwork } });
  check('a damaged notes store on this phone stops the restore at notes with its own sentence',
    report.stoppedAt === 'notes' && report.kinds.at(-1).kind === 'notes' && report.kinds.at(-1).failure === NOTES_READ_ONLY_MESSAGE, JSON.stringify(report.kinds.at(-1)));
  check('…the steps before it are kept (networks, contacts, tokens restored)', (await listContacts(SEPOLIA, F)).length === 1 && (await listTokens(SEPOLIA, F)).length >= 1);
  check('…the steps after it did not run (no recovery record, no multisig)', (await loadRecoveryRecords(F)).entries.length === 0 && (await listMultisigRecords(undefined, F)).length === 0);
  const lines = rb.describeRecordsImport(report);
  check('…and the report names the step', lines.at(-1) === `Restoring stopped at transaction notes: ${NOTES_READ_ONLY_MESSAGE} The records restored before this step stay on this phone.`, lines.at(-1));

  // A damaged document on the exporting phone is left out, and named.
  const G = memStore();
  await populate(G);
  await seam.writeStoreItem(G, seam.STORE_KEYS.contacts.name, 'not json');
  const col = await rb.collectRecordsBackup(G);
  const contactsSummary = col.summary.find((s) => s.kind === 'contacts');
  check('an export leaves out a document its store cannot read', !('shiba-wallet.contacts.v1' in col.documents) && contactsSummary.unreadableDocuments === 1 && contactsSummary.records === 0);
  check('…and the summary sentence names it', rb.describeRecordsExport(col).endsWith('Left out because they could not be read on this phone: Contacts.'), rb.describeRecordsExport(col));

  // Nothing to back up: refused before the key is asked for.
  const counter = { calls: 0 };
  const none = await caught(() => rb.exportRecordsBackup({ store: memStore(), deriveKey: deriverFor(SEED_A, counter) }));
  check('an empty wallet: "no records to back up", no key asked for', none?.message === rb.RECORDS_BACKUP_NOTHING_TO_EXPORT && counter.calls === 0);
}

// ---------------------------------------------------------------------------
console.log('The key behind the approval gate (the real vault, a fake secure store)');
// ---------------------------------------------------------------------------
{
  // Standard (unprotected) phrase: the gate's ordinary prompt, then a read without a prompt.
  const sec = fakeSecure();
  const vault = storage.createKeyVault(sec, { policy: 'opt-in' });
  await vault.saveNewPhrase(PHRASE_A);
  sec.log.length = 0;
  const gate = fakeGate(vault);
  const key = await storage.deriveRecordsBackupKey({ activeAccountId: 0, prompt: storage.RECORDS_BACKUP_PROMPTS.export, salt: SALT, gate: gate.fn, vault });
  check('standard phrase: the key equals the independent HKDF over the phrase\'s seed', Buffer.from(key).equals(Buffer.from(nodeKey(SEED_A, SALT))));
  check('standard phrase: exactly one prompt (the ordinary device check)', gate.calls === 1 && gate.ordinaryPrompts.length === 1 && sec.prompts.length === 0 &&
    gate.ordinaryPrompts[0] === 'Approve making an encrypted backup of your records');
  check('the gate is asked with the phrase as its target', gate.targets.length === 1 && gate.targets[0].kind === 'phrase');
  check('the standard path reads the phrase twice: the gate locating it, then the derivation (no prompt for either)',
    sec.log.filter(([op, k]) => op === 'get' && k === 'shiba-wallet.mnemonic.v1').length === 2);

  // Protected phrase: the vault's own prompt opens it and holds it for the read: one prompt in all.
  const sec2 = fakeSecure();
  const vault2 = storage.createKeyVault(sec2, { policy: 'opt-in' });
  await vault2.saveNewPhrase(PHRASE_A);
  const up = await vault2.upgrade({ prompt: 'protect', checkPrompt: 'check' });
  sec2.prompts.length = 0;
  vault2.setApprovalTarget({ kind: 'none' }); // even with another approval target set, the backup opens the phrase
  const gate2 = fakeGate(vault2);
  const key2 = await storage.deriveRecordsBackupKey({ activeAccountId: 3, prompt: storage.RECORDS_BACKUP_PROMPTS.import, salt: SALT, gate: gate2.fn, vault: vault2 });
  check('protected phrase: exactly one prompt (the protected item\'s own), none from the ordinary gate',
    up.outcome === 'protected' && sec2.prompts.length === 1 && sec2.prompts[0] === 'Approve opening an encrypted backup of your records' && gate2.ordinaryPrompts.length === 0,
    `${up.outcome} ${JSON.stringify(sec2.prompts)} ${JSON.stringify(gate2.ordinaryPrompts)}`);
  check('protected phrase: the same key', Buffer.from(key2).equals(Buffer.from(nodeKey(SEED_A, SALT))));

  // Watch-only, multisig and imported active accounts: refused before anything.
  for (const [name, id] of [['watch-only', watchOnlyAccountId(0)], ['multi-signature', multisigAccountId(0)], ['imported-key', importedAccountId(0)]]) {
    sec.log.length = 0;
    const g = fakeGate(vault);
    const e = await caught(() => storage.deriveRecordsBackupKey({ activeAccountId: id, prompt: 'p', salt: SALT, gate: g.fn, vault }));
    check(`a ${name} active account: refused with the plain sentence, zero secure-store calls, no prompt`,
      e?.message === storage.RECORDS_BACKUP_PHRASE_ACCOUNT_ONLY && sec.log.length === 0 && g.calls === 0, `${e?.message} ${JSON.stringify(sec.log)}`);
  }
  // A cancelled gate: nothing read after it.
  sec.log.length = 0;
  const gc = fakeGate(vault, { cancel: true });
  const ce = await caught(() => storage.deriveRecordsBackupKey({ activeAccountId: 0, prompt: 'p', salt: SALT, gate: gc.fn, vault }));
  // The gate itself locates the phrase (one read, the same as before any
  // signing); after a cancel the derivation reads nothing more.
  const phraseReads = sec.log.filter(([op, k]) => op === 'get' && k === 'shiba-wallet.mnemonic.v1').length;
  check('a cancelled device check: the error, and no phrase read beyond the gate\'s own (the standard path reads twice)', ce?.message === 'Authentication cancelled.' && phraseReads === 1,
    JSON.stringify(sec.log));
  check('a wrong-size salt is refused before the gate', (await caught(() => storage.deriveRecordsBackupKey({ activeAccountId: 0, prompt: 'p', salt: new Uint8Array(16), gate: gc.fn, vault }))) !== null);
}

// ---------------------------------------------------------------------------
console.log('Profile isolation: the decoy wallet (w2) backs up only its own records');
// ---------------------------------------------------------------------------
{
  await resetBridgeTransfers();
  const shared = memStore();
  // The real wallet's records (primary profile).
  await populate(shared);
  const primaryKeys = new Set(shared.map.keys());
  // The decoy's records, written while the decoy profile is active.
  const W2 = { id: 'w2', keyPrefix: 'w2' };
  seam.setActiveStoreProfile(W2);
  try {
    await addContact(SEPOLIA, 'Dora', addr('d4'), { store: shared });
    await saveNote(SEPOLIA, { txid: '0x' + 'ee'.repeat(32) }, 'decoy note', { store: shared });
    shared.reads.length = 0;
    const counter = { calls: 0 };
    const out = await rb.exportRecordsBackup({ store: shared, deriveKey: deriverFor(SEED_OTHER, counter) });
    const deviceWide = new Set(Object.values(seam.STORE_KEYS).filter((d) => d.scope === 'device').map((d) => d.name));
    const leaked = shared.reads.filter((k) => !k.startsWith('shiba-wallet.profile-w2.') && !deviceWide.has(k));
    check('the decoy\'s export reads only shiba-wallet.profile-w2.* keys and device-wide settings, never a primary wallet key',
      leaked.length === 0 && shared.reads.some((k) => k.startsWith('shiba-wallet.profile-w2.')), JSON.stringify(leaked));
    const env = rb.parseRecordsBackupFile(out.text);
    const payload = JSON.parse(new TextDecoder().decode(rb.openRecordsBackup(env, nodeKey(SEED_OTHER, env.salt))));
    const keys = Object.keys(payload.documents);
    check('…its file holds its own contacts and notes, under the unscoped key names (restorable anywhere)',
      keys.includes('shiba-wallet.contacts.v1') && payload.documents['shiba-wallet.contacts.v1'].includes('Dora') && !payload.documents['shiba-wallet.contacts.v1'].includes('Alice') &&
        payload.documents['shiba-wallet.tx-notes.v1'].includes('decoy note') && !payload.documents['shiba-wallet.tx-notes.v1'].includes('rent for October'));
    check('…and none of the real wallet\'s per-wallet records (no multisig, recovery record, alert, limit or bridge transfer)',
      !keys.some((k) => ['shiba-wallet.multisig.v1', 'shiba-wallet.recovery-records.v1', 'shiba-wallet.price-alerts.v1', 'shiba-wallet.spending-policies.v1', 'shiba-wallet.bridge-transfers.v1'].includes(k)), keys.join(' '));
    check('…the networks the user added are device-wide and come along (stated in the notes)', keys.includes('shiba-wallet.custom-networks.v1'));

    // The decoy's vault: the key comes from the decoy's own phrase, read through w2's names only.
    const sec = fakeSecure();
    const decoyVault = storage.createKeyVault(seam.profileBoundSecureBackend(sec, W2), { policy: 'opt-in' });
    await decoyVault.saveNewPhrase(PHRASE_OTHER);
    // The real wallet's phrase under the primary names, beside it.
    await storage.createKeyVault(seam.profileBoundSecureBackend(sec, seam.PRIMARY_STORE_PROFILE), { policy: 'opt-in' }).saveNewPhrase(PHRASE_A);
    sec.log.length = 0;
    const key = await storage.deriveRecordsBackupKey({ activeAccountId: 0, prompt: 'p', salt: SALT, gate: fakeGate(decoyVault).fn, vault: decoyVault });
    check('the decoy\'s key is derived from the decoy\'s phrase (BIP-85 child or not), not the real one', Buffer.from(key).equals(Buffer.from(nodeKey(SEED_OTHER, SALT))));
    check('…reading only shiba-wallet.profile-w2.* secure-store names', sec.log.length > 0 && sec.log.every(([, k]) => k.startsWith('shiba-wallet.profile-w2.')), JSON.stringify(sec.log));
  } finally {
    seam.setActiveStoreProfile(seam.PRIMARY_STORE_PROFILE);
  }
  check('the primary records were not touched by the decoy session', [...primaryKeys].every((k) => shared.map.has(k)));
}

// ---------------------------------------------------------------------------
console.log('Exact strings');
// ---------------------------------------------------------------------------
{
  const exact = {
    RECORDS_BACKUP_SECTION_TITLE: 'Records backup',
    RECORDS_BACKUP_WHAT_NOTE:
      'A records backup is one file with the records this wallet keeps on this phone: contacts, transaction notes, networks you added, tracked tokens, guardian recovery records, multi-signature account records, bridge transfers, price alerts and spending limits. It contains no private key, no recovery phrase and no PIN.',
    RECORDS_BACKUP_KEY_NOTE:
      'The file is encrypted with a key made from this wallet’s recovery phrase, so only this recovery phrase can open it — on this phone, or on another phone after you restore the phrase there. If you lose the recovery phrase, this backup is lost with it.',
    RECORDS_BACKUP_NOT_INCLUDED_NOTE:
      'Not in the backup and not restored by it: session keys (they never leave this phone; a payment, subscription or recurring swap must be revoked and set up again), imported private keys (only the copy of the key you kept yourself can restore such an account) and passkeys (the phone’s passkey provider holds them, not this wallet). Account names, watched addresses, connected apps, pending transactions and spending history are not included either.',
    RECORDS_BACKUP_MERGE_NOTE:
      'Restoring adds only the records that are not on this phone yet. A record that is already here — the same contact address, note, network, token, account, transfer, alert or limit — is kept exactly as it is and never overwritten. Each record is checked as when it was first saved, and a network you added is checked again through its RPC address. A multi-signature account comes back without its operation history.',
    RECORDS_BACKUP_FILE_NOTE:
      'The file is shared through the share sheet (for example to your cloud drive). The temporary copy on this phone is deleted a minute after the share sheet closes.',
    RECORDS_BACKUP_EXPORT_BUTTON: 'Export records backup',
    RECORDS_BACKUP_IMPORT_BUTTON: 'Restore from a records backup',
    RECORDS_BACKUP_DIALOG_TITLE: 'Save the records backup',
    RECORDS_BACKUP_SHARE_UNAVAILABLE: 'Sharing files is not available on this device, so the records backup could not be saved.',
    RECORDS_BACKUP_NOTHING_TO_EXPORT: 'There are no records on this phone to back up yet, so no file was made.',
    RECORDS_BACKUP_NOT_A_BACKUP: 'This file is not a Shiba Wallet records backup, or it is incomplete. Nothing was restored.',
    RECORDS_BACKUP_WRONG_PHRASE: 'This backup was made by a different recovery phrase, or the file is damaged.',
    RECORDS_BACKUP_BAD_CONTENTS: 'The backup opened, but its contents are not in the form this version of the wallet expects, so nothing was restored.',
    RECORDS_BACKUP_CONFIRM_TITLE: 'Restore records from this backup?',
    RECORD_REFUSED_REASON: 'it did not pass this wallet’s checks for that kind of record',
    TOKEN_NETWORK_MISSING_REASON: 'the network it belongs to is not on this phone',
    BRIDGE_CAP_REASON: 'the list keeps only the newest 64 transfers',
    CONTACTS_STORE_UNREADABLE: 'The contacts on this phone could not be read, so none were added.',
    RECOVERY_STORE_UNREADABLE: 'The recovery records on this phone could not be read, so none were added.',
    BRIDGE_STORE_UNREADABLE: 'The list of bridge transfers on this phone could not be read in full, so none were added.',
    SPENDING_STORE_UNREADABLE: 'The spending limits on this phone could not be read, so none were added.',
  };
  for (const [name, text] of Object.entries(exact)) check(`${name} exactly`, rb[name] === text, rb[name]);
  check('the newer-format sentence', rb.recordsBackupNewerFormatMessage(3) === 'This records backup uses format 3, which this version of the wallet cannot read. Update the app and try again. Nothing was restored.');
  check('the prompts', storage.RECORDS_BACKUP_PROMPTS.export === 'Approve making an encrypted backup of your records' &&
    storage.RECORDS_BACKUP_PROMPTS.import === 'Approve opening an encrypted backup of your records');
  check('the phrase-account refusal', storage.RECORDS_BACKUP_PHRASE_ACCOUNT_ONLY ===
    'Records backups are made with your recovery phrase. Switch to an account that comes from your recovery phrase on Home first. Nothing was read.');
  check('the kind labels', JSON.stringify(rb.RECORD_KIND_ORDER.map((k) => rb.RECORD_KIND_LABELS[k])) === JSON.stringify([
    'Networks you added', 'Contacts', 'Tracked tokens', 'Transaction notes', 'Guardian recovery records', 'Multi-signature accounts', 'Bridge transfers',
    'Price alerts and followed prices', 'Spending limits']));
}

// ---------------------------------------------------------------------------
console.log('Source pins: the screen wiring');
// ---------------------------------------------------------------------------
{
  const settings = read('src/screens/SettingsScreen.tsx');
  const section = read('src/screens/RecordsBackupSection.tsx');
  const ctx = read('src/wallet/WalletContext.tsx');
  const backupAt = settings.indexOf('<Button title="Show recovery phrase"');
  const sectionAt = settings.indexOf('<RecordsBackupSection />');
  const protectionAt = settings.indexOf('Recovery phrase protection');
  check('Settings renders the section once, after Backup and before Recovery phrase protection',
    settings.split('<RecordsBackupSection />').length === 2 && backupAt > 0 && sectionAt > backupAt && protectionAt > sectionAt);
  check('the section shares the file through shareTextFile in its own directory with text/plain (the 60-second delete-after-share rule)',
    /shareTextFile\(\{\s*directory: RECORDS_BACKUP_DIRECTORY,[\s\S]*?mimeType: RECORDS_BACKUP_MIME_TYPE,\s*UTI: RECORDS_BACKUP_UTI,/.test(section));
  check('the section renders every honesty note and both buttons',
    ['RECORDS_BACKUP_WHAT_NOTE', 'RECORDS_BACKUP_KEY_NOTE', 'RECORDS_BACKUP_NOT_INCLUDED_NOTE', 'RECORDS_BACKUP_MERGE_NOTE', 'RECORDS_BACKUP_FILE_NOTE',
      'RECORDS_BACKUP_EXPORT_BUTTON', 'RECORDS_BACKUP_IMPORT_BUTTON'].every((n) => section.includes(`{${n}}`) || section.includes(`: ${n}`)));
  check('the section refuses a non-phrase active account before doing anything',
    /if \(!phraseAccountActive\) \{\s*setStatus\(\{ lines: \[RECORDS_BACKUP_PHRASE_ACCOUNT_ONLY\]/.test(section) && section.split('if (!phraseAccountActive)').length === 3);
  check('the section checks the file\'s shape before the confirm dialog and before any prompt',
    section.indexOf('parseRecordsBackupFile(text)') > 0 && section.indexOf('parseRecordsBackupFile(text)') < section.indexOf('Alert.alert(RECORDS_BACKUP_CONFIRM_TITLE'));
  check('the section reads a picked file with the pickRecordFile rules (no cache copy on Android) and wraps read failures',
    section.includes("const copyToCacheDirectory = Platform.OS !== 'android';") && section.includes('throw new RecordFileReadError(e);'));
  check('WalletContext derives the key through the vault function, the device check and the ACTIVE account id',
    /deriveRecordsBackupKeyInVault\(\{\s*activeAccountId: activeIndexRef\.current,\s*prompt: RECORDS_BACKUP_PROMPTS\[purpose\],\s*salt,\s*gate: requireLocalAuth,\s*\}\)/.test(ctx));
  check('no module of this feature logs anything', !/console\./.test(section) && !/console\./.test(read('src/wallet/records-backup.ts')));
}

// ---------------------------------------------------------------------------
console.log('Mutation checks');
// ---------------------------------------------------------------------------
const MUTANT_DIR = join(HERE, `.mutants-records-backup-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(relPath, from, to) {
  const original = read(relPath);
  if (!original.includes(from)) throw new Error(`mutation anchor not found in ${relPath}: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(APP, relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  // 1. Another HKDF info string: the key no longer matches the independent one.
  const m1 = await importMutant('src/wallet/storage.ts', "'shiba-wallet/records-backup/v1/aes-256-gcm-key'", "'shiba-wallet/records-backup/v1'");
  check('mutant (another HKDF info string) is caught', !Buffer.from(m1.recordsBackupKeyFromSeed(SEED_A, SALT)).equals(Buffer.from(nodeKey(SEED_A, SALT))));

  // 2. The header not authenticated (no AAD): the vector no longer matches Node's.
  const m2 = await importMutant('src/wallet/records-backup.ts', 'gcm(key, nonce, header).encrypt(plaintext)', 'gcm(key, nonce).encrypt(plaintext)');
  check('mutant (header not authenticated) is caught', !Buffer.from(m2.sealRecordsBackup(new TextEncoder().encode(VECTOR_PLAINTEXT), nodeKey(SEED_A, SALT), SALT, NONCE)).equals(VECTOR_FILE));

  // 3. The version check removed: a format-2 file reaches the key derivation.
  const m3 = await importMutant('src/wallet/records-backup.ts', 'if (version !== RECORDS_BACKUP_FORMAT_VERSION) {', 'if (false) {');
  const counter = { calls: 0 };
  const e3 = await caught(() => m3.importRecordsBackup({
    text: asText(Buffer.concat([VECTOR_FILE.subarray(0, 4), Buffer.from([2]), VECTOR_FILE.subarray(5)])),
    deriveKey: deriverFor(SEED_A, counter),
    context: { store: memStore(), ownAccounts: [] },
  }));
  check('mutant (version check removed) is caught', e3?.reason !== 'newer-format' && counter.calls === 1);

  // 4. The merge rule broken: an existing note is overwritten.
  const m4 = await importMutant('src/wallet/records-backup.ts', '    if (present) {\n      report.alreadyHere += 1;\n      continue;\n    }\n    try {\n      const saved = await saveNote(', '    if (false) {\n      report.alreadyHere += 1;\n      continue;\n    }\n    try {\n      const saved = await saveNote(');
  await resetBridgeTransfers();
  const C4 = memStore();
  await saveNote(SEPOLIA, { txid: TX_A }, 'my own text', { store: C4 });
  await m4.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A), context: { store: C4, ownAccounts: OWN_ACCOUNTS, verifyNetwork } });
  check('mutant (existing note overwritten) is caught', (await loadNotes(C4)).notes.find((n) => n.txid === TX_A)?.text !== 'my own text');

  // 5. The account guard removed: a watch-only account opens the phrase.
  const m5 = await importMutant('src/wallet/storage.ts', 'if (!isPhraseAccountId(args.activeAccountId)) throw new Error(RECORDS_BACKUP_PHRASE_ACCOUNT_ONLY);', '');
  const sec5 = fakeSecure();
  const v5 = m5.createKeyVault(sec5, { policy: 'opt-in' });
  await v5.saveNewPhrase(PHRASE_A);
  sec5.log.length = 0;
  await caught(() => m5.deriveRecordsBackupKey({ activeAccountId: watchOnlyAccountId(0), prompt: 'p', salt: SALT, gate: fakeGate(v5).fn, vault: v5 }));
  check('mutant (account guard removed) is caught', sec5.log.length > 0);

  // 6. A damaged document exported anyway.
  const m6 = await importMutant('src/wallet/records-backup.ts', '      if (count === null) {\n        entry.unreadableDocuments += 1;\n        continue;\n      }', '');
  const G6 = memStore();
  await seam.writeStoreItem(G6, seam.STORE_KEYS.contacts.name, 'not json');
  await seam.writeStoreItem(G6, seam.STORE_KEYS.txNotes.name, JSON.stringify({ version: 1, networks: {} }));
  check('mutant (damaged document exported) is caught', 'shiba-wallet.contacts.v1' in (await m6.collectRecordsBackup(G6)).documents);

  // 7. The payload's key check removed: an undeclared document is accepted.
  const m7 = await importMutant('src/wallet/records-backup.ts', 'if (recordKindOfKey(key) === null || typeof value !== \'string\') throw bad();', "if (typeof value !== 'string') throw bad();");
  check('mutant (undeclared payload keys accepted) is caught',
    (await caught(() => m7.parseRecordsBackupPayload(JSON.stringify({ type: rb.RECORDS_BACKUP_PAYLOAD_TYPE, version: 1, createdAt: '2026-10-19T00:00:00Z', documents: { 'shiba-wallet.mnemonic.v1': 'x' } })))) === null);

  // 8. The seam bypassed: an export in the decoy profile reads the primary wallet's keys.
  const m8 = await importMutant('src/wallet/records-backup.ts', 'return await readStoreItem(store, key);', 'return await store.getItem(key);');
  await resetBridgeTransfers();
  const S8 = memStore();
  await populate(S8);
  seam.setActiveStoreProfile({ id: 'w2', keyPrefix: 'w2' });
  let leakedDocs;
  try {
    leakedDocs = (await m8.collectRecordsBackup(S8)).documents;
  } finally {
    seam.setActiveStoreProfile(seam.PRIMARY_STORE_PROFILE);
  }
  check('mutant (seam bypassed in a decoy session) is caught', 'shiba-wallet.multisig.v1' in leakedDocs);

  // 9. Tripped alerts restored as armed.
  const m9 = await importMutant('src/wallet/records-backup.ts', '            state: alert.state,\n', '');
  await resetBridgeTransfers();
  const C9 = memStore();
  await m9.importRecordsBackup({ text: exported.text, deriveKey: deriverFor(SEED_A), context: { store: C9, ownAccounts: OWN_ACCOUNTS, verifyNetwork } });
  check('mutant (a tripped alert restored as armed) is caught', (await loadPriceAlerts(C9)).alerts.find((a) => a.direction === 'below')?.state !== 'tripped');
}

console.log(`\n${passed} passed, ${failed} failed (${mutantCount} mutants)`);
process.exit(failed === 0 ? 0 : 1);

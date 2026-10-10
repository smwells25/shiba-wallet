// Exercises transaction notes and the Activity export (feature 87,
// src/wallet/notes.ts) fully offline: an in-memory store stands in for
// AsyncStorage; transaction ids are constructed here. Nothing touches the
// network.
//
// Covered: the note sanitizer (the shared display-name sanitizer plus the
// 280-code-point bound), id normalization per network family, the store's
// strict parse and read-only state for damaged data, Reset and the wipe,
// the write queue, the key rule for smart-account operations (a note saved
// under the UserOperation hash is found under the bundle transaction once
// linked, or through the decoded row's UserOperation hashes), the CSV
// format (RFC 4180 quoting with CRLF line ends; OWASP's CSV-injection
// defusal), exact amounts, the export's row set (exactly the loaded
// entries), the file name, and mutation checks that break the sanitizer,
// the formula defusal, the read-only rule, the link and the export's row
// set.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-notes.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as notes from '../src/wallet/notes.ts';
import { directionLabel } from '../src/wallet/history.ts';

const {
  ACTIVITY_CSV_HEADER,
  MAX_NOTE_LENGTH,
  MAX_NOTES,
  NOTES_READ_ONLY_MESSAGE,
  TX_NOTES_KEY,
  activityCsv,
  activityExportFileName,
  activityExportRows,
  csvDocument,
  csvField,
  defuseFormula,
  exportDate,
  findNote,
  indexNotes,
  linkUserOperation,
  loadNotes,
  normalizeNoteNetwork,
  normalizeTxId,
  normalizeUserOpHash,
  resetNotes,
  sanitizeNote,
  saveNote,
  wipeTransactionNotes,
} = notes;

const HERE = dirname(fileURLToPath(import.meta.url));

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

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function memoryStore(initial = {}, { withRemove = true } = {}) {
  const map = new Map(Object.entries(initial));
  const store = {
    map,
    writes: 0,
    async getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      store.writes += 1;
      map.set(key, value);
    },
  };
  if (withRemove) {
    store.removeItem = async (key) => {
      map.delete(key);
    };
  }
  return store;
}

const SEPOLIA = 'eip155:11155111';
const MAINNET = 'eip155:1';
const BITCOIN = 'bip122:000000000019d6689c085ae165831e93';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const hex64 = (seed) => seed.repeat(64).slice(0, 64);
const TX_A = '0x' + hex64('a1');
const TX_B = '0x' + hex64('b2');
const TX_C = '0x' + hex64('c3');
const OP_1 = '0x' + hex64('d4');
const OP_2 = '0x' + hex64('e5');
const BTC_TX = hex64('9f');
const SOL_SIG = '5' + 'VERYLongBase58Signature'.replace(/[0OIl]/g, 'x') + '1'.repeat(40);
const fixedNow = () => new Date('2026-10-10T08:15:00.000Z');

// ---------------------------------------------------------------------------
console.log('Sanitizer');
// ---------------------------------------------------------------------------
{
  check('plain note kept', sanitizeNote('Rent for October').ok && sanitizeNote('Rent for October').note === 'Rent for October');
  check('surrounding whitespace trimmed', sanitizeNote('  lunch  ').note === 'lunch');
  check('newline and tab collapse to one space', sanitizeNote('line one\n\n\tline two').note === 'line one line two');
  check('C0 control removed', sanitizeNote('a\u0000b\u0007c').note === 'abc');
  check('C1 control removed', sanitizeNote('a\u0085b\u009Fc').note === 'abc',
    JSON.stringify(sanitizeNote('a\u0085b\u009Fc')));
  check('right-to-left override removed', sanitizeNote('pay‮gnp.exe').note === 'paygnp.exe');
  check('isolates and LRM/RLM removed', sanitizeNote('⁦a⁩‎b‏c؜').note === 'abc');
  check('zero-width space, word joiner and BOM removed', sanitizeNote('a​b⁠c﻿d').note === 'abcd');
  check('ZWJ kept (emoji sequences need it)', sanitizeNote('👩‍💻').note === '👩‍💻');
  check('NFC applied', sanitizeNote('é').note === 'é');
  check('empty after cleaning is valid and means "no note"', sanitizeNote(' ​\n ').ok && sanitizeNote(' ​\n ').note === '');
  check('280 code points accepted', sanitizeNote('x'.repeat(MAX_NOTE_LENGTH)).ok);
  const long = sanitizeNote('x'.repeat(MAX_NOTE_LENGTH + 1));
  check('281 code points refused with a sentence', !long.ok && long.error === 'A note can be at most 280 characters (this one is 281).', long.error);
  check('280 emoji (560 UTF-16 units) accepted: code points, not units', sanitizeNote('🐕'.repeat(280)).ok);
  check('281 emoji refused', !sanitizeNote('🐕'.repeat(281)).ok);
  check('non-string refused', !sanitizeNote(42).ok);
}

// ---------------------------------------------------------------------------
console.log('Ids');
// ---------------------------------------------------------------------------
{
  check('EVM hash lowercased', normalizeTxId(SEPOLIA, TX_A.toUpperCase().replace('0X', '0x')) === TX_A);
  check('EVM hash without 0x refused', normalizeTxId(SEPOLIA, TX_A.slice(2)) === null);
  check('short EVM hash refused', normalizeTxId(SEPOLIA, TX_A.slice(0, 60)) === null);
  check('Bitcoin txid lowercased', normalizeTxId(BITCOIN, BTC_TX.toUpperCase()) === BTC_TX);
  check('Bitcoin txid with 0x refused', normalizeTxId(BITCOIN, '0x' + BTC_TX) === null);
  check('Solana signature kept exactly (base58 is case-sensitive)', normalizeTxId(SOLANA, SOL_SIG) === SOL_SIG);
  check('Solana signature with a 0 refused (not base58)', normalizeTxId(SOLANA, SOL_SIG.replace('1', '0')) === null);
  check('unsupported namespace refused', normalizeNoteNetwork('cosmos:cosmoshub-4') === null && normalizeTxId('cosmos:cosmoshub-4', TX_A) === null);
  check('malformed network refused', normalizeNoteNetwork('eip155') === null && normalizeNoteNetwork('EIP155:1') === null);
  check('UserOperation hash only on EVM', normalizeUserOpHash(SEPOLIA, OP_1) === OP_1 && normalizeUserOpHash(BITCOIN, BTC_TX) === null);
}

// ---------------------------------------------------------------------------
console.log('Store basics');
// ---------------------------------------------------------------------------
{
  const store = memoryStore();
  const empty = await loadNotes(store);
  check('empty store: no notes, writable', empty.notes.length === 0 && empty.readOnly === false);
  const saved = await saveNote(SEPOLIA, { txid: TX_A.toUpperCase().replace('0X', '0x') }, '  Rent\nOctober ', { store, now: fixedNow });
  check('save returns the cleaned note under the normalized id',
    saved.text === 'Rent October' && saved.txid === TX_A && saved.userOpHash === null && saved.updatedAt === '2026-10-10T08:15:00.000Z');
  const raw = JSON.parse(store.map.get(TX_NOTES_KEY));
  check('stored under shiba-wallet.tx-notes.v1, version 1, per network, tx: key',
    TX_NOTES_KEY === 'shiba-wallet.tx-notes.v1' && raw.version === 1 &&
      JSON.stringify(raw.networks) === JSON.stringify({ [SEPOLIA]: { [`tx:${TX_A}`]: { text: 'Rent October', updatedAt: '2026-10-10T08:15:00.000Z' } } }));
  const book = await loadNotes(store);
  const index = indexNotes(book.notes);
  check('found by transaction id', findNote(index, SEPOLIA, TX_A)?.text === 'Rent October');
  check('found case-insensitively', findNote(index, SEPOLIA, TX_A.toUpperCase().replace('0X', '0x'))?.text === 'Rent October');
  check('not found on another network', findNote(index, MAINNET, TX_A) === null);
  await saveNote(SEPOLIA, { txid: TX_A }, 'Rent for October', { store });
  check('edit replaces the note', (await loadNotes(store)).notes.length === 1 && (await loadNotes(store)).notes[0].text === 'Rent for October');
  const removed = await saveNote(SEPOLIA, { txid: TX_A }, ' \n ', { store });
  check('saving an empty note removes it (and the empty network)',
    removed === null && JSON.stringify(JSON.parse(store.map.get(TX_NOTES_KEY)).networks) === '{}');
  check('too-long note refused, nothing written', (await rejects(() => saveNote(SEPOLIA, { txid: TX_A }, 'y'.repeat(281), { store })))?.startsWith('A note can be at most 280'));
  check('invalid id refused', (await rejects(() => saveNote(SEPOLIA, { txid: '0x1234' }, 'x', { store }))) === 'This transaction id is not valid on this network.');
  check('no id refused', (await rejects(() => saveNote(SEPOLIA, {}, 'x', { store }))) === 'A note needs a transaction id or a UserOperation hash.');
  check('unsupported network refused', (await rejects(() => saveNote('cosmos:cosmoshub-4', { txid: TX_A }, 'x', { store })))?.startsWith('Notes are not supported'));
  check('UserOperation hash on Bitcoin refused', (await rejects(() => saveNote(BITCOIN, { userOpHash: OP_1 }, 'x', { store }))) === 'This UserOperation hash is not valid on this network.');
  await saveNote(BITCOIN, { txid: BTC_TX }, 'BTC note', { store });
  await saveNote(SOLANA, { txid: SOL_SIG }, 'SOL note', { store });
  const idx2 = indexNotes((await loadNotes(store)).notes);
  check('Bitcoin and Solana notes', findNote(idx2, BITCOIN, BTC_TX)?.text === 'BTC note' && findNote(idx2, SOLANA, SOL_SIG)?.text === 'SOL note');

  // The write queue: many saves at once all land.
  const busy = memoryStore();
  const ids = Array.from({ length: 20 }, (_, i) => '0x' + i.toString(16).padStart(64, '0'));
  // A slow store makes every read-modify-write overlap without the queue.
  const slow = {
    ...busy,
    async getItem(key) {
      await new Promise((r) => setTimeout(r, 2));
      return busy.getItem(key);
    },
    async setItem(key, value) {
      await new Promise((r) => setTimeout(r, 2));
      return busy.setItem(key, value);
    },
  };
  await Promise.all(ids.map((id, i) => saveNote(SEPOLIA, { txid: id }, `note ${i}`, { store: slow })));
  check('20 concurrent saves: all 20 kept (one write queue per store)', (await loadNotes(slow)).notes.length === 20);
}

// ---------------------------------------------------------------------------
console.log('Key rule: UserOperation hash → bundle transaction');
// ---------------------------------------------------------------------------
{
  // (1) Saved before the receipt, linked when it arrives.
  const store = memoryStore();
  await saveNote(SEPOLIA, { userOpHash: OP_1 }, 'Paid Bob from the smart account', { store });
  let index = indexNotes((await loadNotes(store)).notes);
  check('before the link: Activity (bundle tx) does not see it by id alone', findNote(index, SEPOLIA, TX_B) === null);
  check('before the link: a decoded row carrying the operation finds it', findNote(index, SEPOLIA, TX_B, [OP_1])?.text === 'Paid Bob from the smart account');
  check('link moves it', (await linkUserOperation(SEPOLIA, OP_1, TX_B, store)) === 'moved');
  const raw = JSON.parse(store.map.get(TX_NOTES_KEY)).networks[SEPOLIA];
  check('stored under tx:<bundle hash> with the UserOperation hash kept; op: record gone',
    JSON.stringify(Object.keys(raw)) === JSON.stringify([`tx:${TX_B}`]) && raw[`tx:${TX_B}`].userOpHash === OP_1);
  index = indexNotes((await loadNotes(store)).notes);
  check('after the link: Activity finds it by the bundle transaction id', findNote(index, SEPOLIA, TX_B)?.text === 'Paid Bob from the smart account');
  check('a second link is a no-op', (await linkUserOperation(SEPOLIA, OP_1, TX_B, store)) === 'none');
  // The success screen still holds only the UserOperation hash: an edit then
  // updates the linked record instead of creating a second one.
  await saveNote(SEPOLIA, { userOpHash: OP_1 }, 'Paid Bob (edited)', { store });
  const after = (await loadNotes(store)).notes;
  check('edit by UserOperation hash after the link updates the linked note', after.length === 1 && after[0].txid === TX_B && after[0].text === 'Paid Bob (edited)');
  // An edit by transaction id keeps the UserOperation hash on the record.
  await saveNote(SEPOLIA, { txid: TX_B }, 'Paid Bob (edited twice)', { store });
  check('edit by transaction id keeps the UserOperation hash', (await loadNotes(store)).notes[0].userOpHash === OP_1);
  await saveNote(SEPOLIA, { userOpHash: OP_1 }, '', { store });
  check('removing by UserOperation hash removes the linked note', (await loadNotes(store)).notes.length === 0);

  // (2) Saved with both ids (receipt already in): one tx record.
  const s2 = memoryStore();
  await saveNote(SEPOLIA, { userOpHash: OP_2 }, 'first', { store: s2 });
  await saveNote(SEPOLIA, { txid: TX_C, userOpHash: OP_2 }, 'second', { store: s2 });
  const r2 = JSON.parse(s2.map.get(TX_NOTES_KEY)).networks[SEPOLIA];
  check('save with both ids moves the op: note to tx: (one record)', JSON.stringify(Object.keys(r2)) === JSON.stringify([`tx:${TX_C}`]) && r2[`tx:${TX_C}`].text === 'second');

  // (3) Collision: a note already exists under the transaction id.
  const s3 = memoryStore();
  await saveNote(SEPOLIA, { txid: TX_A }, 'written in Activity', { store: s3 });
  await saveNote(SEPOLIA, { userOpHash: OP_1 }, 'written on the success screen', { store: s3 });
  check('link onto an existing note keeps both', (await linkUserOperation(SEPOLIA, OP_1, TX_A, s3)) === 'kept-separate' && (await loadNotes(s3)).notes.length === 2);
  check('the transaction-id note is the one shown', findNote(indexNotes((await loadNotes(s3)).notes), SEPOLIA, TX_A, [OP_1])?.text === 'written in Activity');
  check('link with invalid ids rejects', (await rejects(() => linkUserOperation(SEPOLIA, '0x12', TX_A, s3))) !== null);
}

// ---------------------------------------------------------------------------
console.log('Damaged storage: read-only, Reset, wipe');
// ---------------------------------------------------------------------------
{
  const good = { text: 'kept', updatedAt: '2026-10-10T08:15:00.000Z' };
  async function readOnlyCase(name, text, expectNotes) {
    const store = memoryStore(text === undefined ? {} : { [TX_NOTES_KEY]: text });
    const book = await loadNotes(store);
    check(`${name}: read-only`, book.readOnly === true);
    check(`${name}: ${expectNotes} valid note(s) still shown`, book.notes.length === expectNotes, String(book.notes.length));
    const before = store.map.get(TX_NOTES_KEY);
    check(`${name}: save refused with the Reset sentence`, (await rejects(() => saveNote(SEPOLIA, { txid: TX_C }, 'new', { store }))) === NOTES_READ_ONLY_MESSAGE);
    check(`${name}: link reports read-only`, (await linkUserOperation(SEPOLIA, OP_1, TX_C, store)) === 'read-only');
    check(`${name}: nothing written`, store.map.get(TX_NOTES_KEY) === before);
    return store;
  }
  const doc = (networks, version = 1) => JSON.stringify({ version, networks });
  await readOnlyCase('bad JSON', '{"version":1,', 0);
  await readOnlyCase('unknown version', doc({ [SEPOLIA]: { [`tx:${TX_A}`]: good } }, 2), 0);
  await readOnlyCase('array instead of object', '[]', 0);
  await readOnlyCase('networks not an object', JSON.stringify({ version: 1, networks: [] }), 0);
  await readOnlyCase('unsanitized text (RLO) in one entry', doc({ [SEPOLIA]: { [`tx:${TX_A}`]: good, [`tx:${TX_B}`]: { ...good, text: 'a‮b' } } }), 1);
  await readOnlyCase('text over 280 code points', doc({ [SEPOLIA]: { [`tx:${TX_A}`]: good, [`tx:${TX_B}`]: { ...good, text: 'z'.repeat(281) } } }), 1);
  await readOnlyCase('empty text', doc({ [SEPOLIA]: { [`tx:${TX_A}`]: { ...good, text: '' } } }), 0);
  await readOnlyCase('uppercase id in the key', doc({ [SEPOLIA]: { [`tx:${TX_A.toUpperCase().replace('0X', '0x')}`]: good } }), 0);
  await readOnlyCase('unknown field', doc({ [SEPOLIA]: { [`tx:${TX_A}`]: { ...good, synced: true } } }), 0);
  await readOnlyCase('bad date', doc({ [SEPOLIA]: { [`tx:${TX_A}`]: { ...good, updatedAt: 'yesterday' } } }), 0);
  await readOnlyCase('op: record carrying a userOpHash field', doc({ [SEPOLIA]: { [`op:${OP_1}`]: { ...good, userOpHash: OP_1 } } }), 0);
  await readOnlyCase('unknown key prefix', doc({ [SEPOLIA]: { [`note:${TX_A}`]: good } }), 0);
  await readOnlyCase('unsupported network', doc({ 'cosmos:cosmoshub-4': {} }), 0);
  const throwing = {
    async getItem() {
      throw new Error('storage failed');
    },
    async setItem() {
      throw new Error('must not write');
    },
  };
  const tb = await loadNotes(throwing);
  check('storage read failure: read-only, no notes', tb.readOnly && tb.notes.length === 0);

  const damaged = memoryStore({ [TX_NOTES_KEY]: '{"version":1,' });
  await resetNotes(damaged);
  const reset = await loadNotes(damaged);
  check('Reset: empty and writable again', reset.notes.length === 0 && reset.readOnly === false);
  check('after Reset a save works', (await saveNote(SEPOLIA, { txid: TX_A }, 'fresh', { store: damaged }))?.text === 'fresh');

  await wipeTransactionNotes(damaged);
  check('wipe removes the key (removeItem)', !damaged.map.has(TX_NOTES_KEY));
  const noRemove = memoryStore({}, { withRemove: false });
  await saveNote(SEPOLIA, { txid: TX_A }, 'x', { store: noRemove });
  await wipeTransactionNotes(noRemove);
  check('wipe without removeItem leaves an empty store', (await loadNotes(noRemove)).notes.length === 0 && !(await loadNotes(noRemove)).readOnly);

  // MAX_NOTES: a new note beyond the bound is refused; an edit is not.
  const records = {};
  for (let i = 0; i < MAX_NOTES; i += 1) records[`tx:0x${i.toString(16).padStart(64, '0')}`] = good;
  const full = memoryStore({ [TX_NOTES_KEY]: doc({ [SEPOLIA]: records }) });
  check(`MAX_NOTES (${MAX_NOTES}): a new note refused`,
    (await rejects(() => saveNote(SEPOLIA, { txid: TX_A }, 'one more', { store: full })))?.startsWith(`This phone already keeps ${MAX_NOTES} transaction notes`));
  check('MAX_NOTES: editing an existing note still works',
    (await saveNote(SEPOLIA, { txid: '0x' + '0'.repeat(64) }, 'edited', { store: full }))?.text === 'edited');
}

// ---------------------------------------------------------------------------
console.log('CSV');
// ---------------------------------------------------------------------------
{
  check('plain field quoted', csvField('abc') === '"abc"');
  check('comma kept inside quotes', csvField('a,b') === '"a,b"');
  check('double quote doubled', csvField('say "hi"') === '"say ""hi"""');
  check('newline kept inside quotes', csvField('a\r\nb') === '"a\r\nb"');
  for (const lead of ['=', '+', '-', '@', '\t', '\r', '\n']) {
    check(`leading ${JSON.stringify(lead)} gets an apostrophe`, defuseFormula(`${lead}1+1`) === `'${lead}1+1`);
  }
  check('HYPERLINK formula defused and quoted', csvField('=HYPERLINK("http://x","y")') === '"\'=HYPERLINK(""http://x"",""y"")"');
  check('a formula char later in the text is left alone', defuseFormula('a=b') === 'a=b');
  check('document: CRLF after every row', csvDocument([['a', 'b'], ['c', 'd']]) === '"a","b"\r\n"c","d"\r\n');
  check('directionWord equals history.ts directionLabel',
    ['in', 'out', 'self'].every((d) => {
      const row = activityExportRows({
        network: SEPOLIA, networkLabel: 'Ethereum Sepolia', nativeSymbol: 'test ETH', nativeDecimals: 18,
        notes: indexNotes([]), explorerUrlFor: () => null,
        entries: [{ id: TX_A, timestamp: null, confirmed: true, direction: d }],
      })[0];
      return row[2] === directionLabel(d);
    }));
  check('date: ISO UTC without milliseconds', exportDate({ timestamp: 1760084100, confirmed: true }) === '2025-10-10T08:15:00Z');
  check('date: pending', exportDate({ timestamp: null, confirmed: false }) === 'pending');
  check('date: block only', exportDate({ timestamp: null, confirmed: true, blockHeight: 123 }) === 'block 123');
}

// ---------------------------------------------------------------------------
console.log('Export');
// ---------------------------------------------------------------------------
const ENTRIES = [
  // Native, 1 wei and a fee: exact strings.
  { id: TX_A, timestamp: 1760084100, confirmed: true, direction: 'out', amount: 1n, fee: 21000n * 1234567891n },
  // Token with exact amount (two entries of one transaction, uid differs).
  { id: TX_B, uid: `${TX_B}:0`, timestamp: 1760084000, confirmed: true, direction: 'in', assetSymbol: 'USDC', assetAmount: 1234567n, assetDecimals: 6 },
  { id: TX_B, uid: `${TX_B}:1`, timestamp: 1760084000, confirmed: true, direction: 'in', amount: 10n ** 18n + 5n },
  // Token without an exact amount: amount left empty.
  { id: TX_C, timestamp: null, confirmed: false, direction: 'self', assetSymbol: '=cmd|calc', failed: true },
];
async function exportFixture(mod = notes) {
  const store = memoryStore();
  await mod.saveNote(SEPOLIA, { txid: TX_A }, 'Rent, "October"', { store });
  await mod.saveNote(SEPOLIA, { txid: TX_B }, '=SUM(A1:A9)', { store });
  // A note the user wrote for a transaction NOT loaded on the screen.
  await mod.saveNote(SEPOLIA, { txid: '0x' + hex64('77') }, 'NOT LOADED secret note', { store });
  // A note saved under a UserOperation hash that the decoded row of TX_C carries.
  await mod.saveNote(SEPOLIA, { userOpHash: OP_1 }, '@via the operation', { store });
  const book = await mod.loadNotes(store);
  return {
    network: SEPOLIA,
    networkLabel: 'Ethereum Sepolia',
    entries: ENTRIES,
    nativeSymbol: 'test ETH',
    nativeDecimals: 18,
    notes: mod.indexNotes(book.notes),
    explorerUrlFor: (id) => `https://sepolia.etherscan.io/tx/${id}`,
    counterpartyFor: (id) => (id === TX_A ? '0x1111111111111111111111111111111111111111' : null),
    userOpHashesFor: (id) => (id === TX_C ? [OP_1] : []),
  };
}
{
  const input = await exportFixture();
  const rows = activityExportRows(input);
  check('one row per loaded entry, same order', rows.length === ENTRIES.length && rows.every((r, i) => r[8] === ENTRIES[i].id));
  check('header', JSON.stringify(ACTIVITY_CSV_HEADER) === JSON.stringify(['network', 'date (UTC)', 'direction', 'amount', 'asset', 'fee', 'fee asset', 'counterparty', 'transaction id', 'explorer URL', 'note']));
  check('every row has the header width', rows.every((r) => r.length === ACTIVITY_CSV_HEADER.length));
  check('network cell', rows[0][0] === 'Ethereum Sepolia (eip155:11155111)');
  check('1 wei is exact', rows[0][3] === '0.000000000000000001' && rows[0][4] === 'test ETH');
  check('fee exact with its asset', rows[0][5] === '0.000025925925711' && rows[0][6] === 'test ETH', `${rows[0][5]}`);
  check('token amount in its own decimals', rows[1][3] === '1.234567' && rows[1][4] === 'USDC' && rows[1][5] === '' && rows[1][6] === '');
  check('native amount above 1 exact', rows[2][3] === '1.000000000000000005');
  check('token without exact amount: amount empty, asset named', rows[3][3] === '' && rows[3][4] === '=cmd|calc');
  check('failed shown in direction', rows[3][2] === 'Self (failed)');
  check('pending date', rows[3][1] === 'pending');
  check('counterparty only where known', rows[0][7] === '0x1111111111111111111111111111111111111111' && rows[1][7] === '');
  check('explorer URL', rows[0][9] === `https://sepolia.etherscan.io/tx/${TX_A}`);
  check('notes on their rows (both entries of one transaction)', rows[0][10] === 'Rent, "October"' && rows[1][10] === '=SUM(A1:A9)' && rows[2][10] === '=SUM(A1:A9)');
  check('note found through the decoded row\'s UserOperation hash', rows[3][10] === '@via the operation');
  const csv = activityCsv(input);
  const lines = csv.split('\r\n');
  check('CSV: header + 4 rows + final CRLF', lines.length === 6 && lines[5] === '');
  check('CSV: the note of an unloaded transaction is absent', !csv.includes('NOT LOADED'));
  check('CSV: a note with a comma and quotes is quoted and doubled', lines[1].includes('"Rent, ""October"""'));
  check('CSV: a note starting with = is defused', lines[2].endsWith(',"\'=SUM(A1:A9)"'));
  check('CSV: a backend token symbol starting with = is defused', lines[4].includes('"\'=cmd|calc"'));
  check('CSV: a note starting with @ is defused', lines[4].endsWith(',"\'@via the operation"'));
  check('CSV: no float artefacts', !/e-\d|e\+\d/.test(csv));
  check('empty export: header only', activityCsv({ ...input, entries: [] }) === csvDocument([ACTIVITY_CSV_HEADER]));
  check('file name',
    activityExportFileName(SEPOLIA, '0x772e9f0A3B6f3b1F0c2e1C0D6dB34b7aE9cAF44F', new Date('2026-10-10T23:59:00Z')) ===
      'shiba-activity_eip155-11155111_0x772e-F44F_2026-10-10.csv');
  check('file name for Bitcoin uses only safe characters',
    /^shiba-activity_[A-Za-z0-9-]+_[A-Za-z0-9-]+_\d{4}-\d{2}-\d{2}\.csv$/.test(activityExportFileName(BITCOIN, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')));
}

// ---------------------------------------------------------------------------
console.log('Mutation checks');
// ---------------------------------------------------------------------------
const MUTANT_DIR = join(HERE, `.mutants-notes-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(from, to) {
  const relPath = 'src/wallet/notes.ts';
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-notes.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  // 1. Sanitizer removed: control and bidi characters survive.
  const m1 = await importMutant(
    "const cleaned = sanitizeDisplayName(raw.replace(/[\\t\\n\\v\\f\\r]/g, ' '), Number.MAX_SAFE_INTEGER, 'note');\n  const note = cleaned.ok ? cleaned.name : '';",
    "const note = raw;",
  );
  check('mutant (sanitizer removed) is caught', m1.sanitizeNote('pay‮gnp.exe').note !== 'paygnp.exe');

  // 2. Formula defusal removed.
  const m2 = await importMutant('return FORMULA_START_RE.test(value) ? `\'${value}` : value;', 'return value;');
  const csv2 = m2.activityCsv(await exportFixture(m2));
  check('mutant (formula defusal removed) is caught', csv2.includes(',"=SUM(A1:A9)"') && !csv2.includes('"\'=SUM'));

  // 3. Notes synced into the export when the user did not load them.
  const m3 = await importMutant(
    'return csvDocument([ACTIVITY_CSV_HEADER, ...activityExportRows(input)]);',
    "return csvDocument([ACTIVITY_CSV_HEADER, ...activityExportRows(input), ...[...input.notes.byTx.values()].map((n) => ['', '', '', '', '', '', '', '', n.txid ?? '', '', n.text])]);",
  );
  const csv3 = m3.activityCsv(await exportFixture(m3));
  check('mutant (unloaded notes added to the export) is caught', csv3.includes('NOT LOADED') && csv3.split('\r\n').length !== 6);

  // 4. Read-only rule removed: a damaged entry is silently dropped on write.
  const m4 = await importMutant(
    "if (read.state === 'unreadable' || (read.state === 'ok' && read.dropped > 0)) {",
    "if (read.state === 'unreadable') {",
  );
  const damaged = memoryStore({
    [TX_NOTES_KEY]: JSON.stringify({ version: 1, networks: { [SEPOLIA]: { [`tx:${TX_A}`]: { text: 'a‮b', updatedAt: '2026-10-10T08:15:00.000Z' } } } }),
  });
  const m4error = await rejects(() => m4.saveNote(SEPOLIA, { txid: TX_B }, 'x', { store: damaged }));
  check('mutant (writes allowed on a damaged store) is caught', m4error === null);

  // 5. The link does not move the note: Activity cannot find it by the bundle hash.
  const m5 = await importMutant("delete records[`op:${hash}`];\n    await writeRaw(loaded.raw, store);\n    return 'moved' as const;", "return 'moved' as const;");
  const s5 = memoryStore();
  await m5.saveNote(SEPOLIA, { userOpHash: OP_1 }, 'op note', { store: s5 });
  await m5.linkUserOperation(SEPOLIA, OP_1, TX_B, s5);
  check('mutant (link that does not move) is caught', m5.findNote(m5.indexNotes((await m5.loadNotes(s5)).notes), SEPOLIA, TX_B) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

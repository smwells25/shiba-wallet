// Exercises the app's contacts store and anti-poisoning matcher
// (src/wallet/contacts.ts) fully offline: an in-memory KeyValueStore stands
// in for AsyncStorage, and every address comes from the standard BIP-39
// test mnemonic ("abandon ... about", public knowledge) or is constructed
// here. Nothing touches the network.
//
// Like the other check scripts, it imports the actual TypeScript module the
// app runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-contacts.mjs

import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  evmKeyProvider,
  mnemonicToSeed,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import { base58, bech32 } from '@scure/base';
import {
  BITCOIN_CHAIN_ID,
  DOGECOIN_CHAIN_ID,
  EVM_CHAIN_ID,
  SOLANA_CHAIN_ID,
  validateRecipient,
} from '../src/wallet/send.ts';
import { EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import {
  LookalikeContactError,
  addContact,
  deleteContact,
  exactMatchKey,
  findExactContact,
  findLookalikes,
  listContacts,
  loadContacts,
  lookalikeWarning,
  matchRecipient,
  renameContact,
  resetContacts,
  sanitizeContactName,
  validateContactAddress,
} from '../src/wallet/contacts.ts';

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

async function checkRejects(name, fn, messagePart) {
  try {
    const value = await fn();
    check(name, false, `expected an error, got ${JSON.stringify(value)}`);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(messagePart), `error was: ${message}`);
    return e;
  }
}

const CONTACTS_KEY = 'shiba-wallet.contacts.v1';

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
  };
}

const SEPOLIA = EVM_SEPOLIA.caip2;

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const ETH = evmKeyProvider.deriveAccount(seed, 0, 0).address;
const ETH2 = evmKeyProvider.deriveAccount(seed, 0, 1).address;
const BTC = bitcoinKeyProvider.deriveAccount(seed, 0, 0).address;
const BTC2 = bitcoinKeyProvider.deriveAccount(seed, 0, 1).address;
const DOGE = dogecoinKeyProvider.deriveAccount(seed, 0, 0).address;
const DOGE2 = dogecoinKeyProvider.deriveAccount(seed, 0, 1).address;
const SOL = solanaKeyProvider.deriveAccount(seed, 0, 0).address;
const SOL2 = solanaKeyProvider.deriveAccount(seed, 1, 0).address;

// ---------------------------------------------------------------------------
console.log('Address validation on all four chains (+ Sepolia), via validateRecipient:');

for (const [label, networkId, good, bad] of [
  ['Ethereum', EVM_CHAIN_ID, ETH, ETH.slice(0, -1)],
  ['Sepolia', SEPOLIA, ETH, `${ETH}00`],
  ['Bitcoin', BITCOIN_CHAIN_ID, BTC, DOGE],
  ['Dogecoin', DOGECOIN_CHAIN_ID, DOGE, BTC],
  ['Solana', SOLANA_CHAIN_ID, SOL, ETH],
]) {
  const v = validateContactAddress(networkId, good);
  check(`${label}: derived address validates`, v.ok, JSON.stringify(v));
  const b = validateContactAddress(networkId, bad);
  check(`${label}: wrong/garbled address is rejected`, !b.ok);
  // Same verdict as the send flow's validator (the one source of truth).
  const slot = networkId === SEPOLIA ? EVM_CHAIN_ID : networkId;
  check(
    `${label}: verdicts identical to validateRecipient`,
    validateRecipient(slot, good).ok === v.ok && validateRecipient(slot, bad).ok === b.ok,
  );
}
check(
  'unsupported network is refused',
  !validateContactAddress('cosmos:cosmoshub-4', 'cosmos1xyz').ok,
);
check(
  'Bitcoin: taproot address rejected with the engine message',
  (() => {
    const v = validateContactAddress(
      BITCOIN_CHAIN_ID,
      'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
    );
    return !v.ok && /Taproot/.test(v.error);
  })(),
);

// ---------------------------------------------------------------------------
console.log('EIP-55 / canonical normalization:');
{
  const store = memoryStore();
  const saved = await addContact(EVM_CHAIN_ID, 'Alice', ETH.toLowerCase(), { store });
  check('lowercase EVM input is stored EIP-55 checksummed', saved.address === ETH, saved.address);
  const persisted = JSON.parse(store.map.get(CONTACTS_KEY));
  check(
    'persisted JSON carries the checksummed form',
    persisted.networks[EVM_CHAIN_ID][0].address === ETH,
  );
  const mixedBad = ETH.slice(0, 2) + ETH.slice(2).split('').map((c, i) =>
    i === 5 && /[a-f]/i.test(c) ? (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) : c,
  ).join('');
  await checkRejects(
    'mixed-case address with a broken checksum is refused',
    () => addContact(EVM_CHAIN_ID, 'Bob', mixedBad, { store }),
    'checksum',
  );
  const up = await addContact(BITCOIN_CHAIN_ID, 'Carol', BTC.toUpperCase(), { store });
  check('all-uppercase bech32 is stored lowercase (BIP-173 canonical)', up.address === BTC, up.address);
  await checkRejects(
    'same bech32 address in lowercase is then a duplicate',
    () => addContact(BITCOIN_CHAIN_ID, 'Carol again', BTC, { store }),
    '“Carol”',
  );
}

// ---------------------------------------------------------------------------
console.log('Store discipline (invalid / duplicate / unsupported persist nothing):');
{
  const store = memoryStore();
  await addContact(EVM_CHAIN_ID, 'Alice', ETH, { store });
  const snapshot = store.map.get(CONTACTS_KEY);
  await checkRejects(
    'invalid address refused',
    () => addContact(EVM_CHAIN_ID, 'Mallory', '0x1234', { store }),
    '40 hex',
  );
  await checkRejects(
    'duplicate address (different case) refused, naming the existing contact',
    () => addContact(EVM_CHAIN_ID, 'Alice 2', ETH.toLowerCase(), { store }),
    'already saved as your contact “Alice”',
  );
  await checkRejects(
    'duplicate name (case-insensitive) on the same network refused',
    () => addContact(EVM_CHAIN_ID, 'alice', ETH2, { store }),
    'already have a contact named “Alice”',
  );
  await checkRejects(
    'empty name refused',
    () => addContact(EVM_CHAIN_ID, '   ', ETH2, { store }),
    'Enter a name',
  );
  await checkRejects(
    'unsupported network refused',
    () => addContact('cosmos:cosmoshub-4', 'X', 'cosmos1abc', { store }),
    'not supported',
  );
  check('storage byte-identical after every refused write', store.map.get(CONTACTS_KEY) === snapshot);
  const list = await listContacts(EVM_CHAIN_ID, store);
  check('list still holds exactly the one valid contact', list.length === 1 && list[0].name === 'Alice');
}

// ---------------------------------------------------------------------------
console.log('Per-chain and per-mode isolation:');
{
  const store = memoryStore();
  await addContact(EVM_CHAIN_ID, 'Mainnet Alice', ETH, { store });
  await addContact(SEPOLIA, 'Sepolia Bob', ETH2, { store });
  await addContact(BITCOIN_CHAIN_ID, 'BTC Carol', BTC, { store });
  await addContact(DOGECOIN_CHAIN_ID, 'DOGE Dave', DOGE, { store });
  await addContact(SOLANA_CHAIN_ID, 'SOL Erin', SOL, { store });
  const mainnet = await listContacts(EVM_CHAIN_ID, store);
  const sepolia = await listContacts(SEPOLIA, store);
  check('mainnet list shows only the mainnet contact', mainnet.length === 1 && mainnet[0].name === 'Mainnet Alice');
  check('Sepolia list shows only the Sepolia contact', sepolia.length === 1 && sepolia[0].name === 'Sepolia Bob');
  check(
    'a mainnet contact never labels a Sepolia recipient',
    matchRecipient(SEPOLIA, ETH, sepolia).kind === 'none' &&
      findExactContact(SEPOLIA, ETH, [...mainnet, ...sepolia]) === null,
  );
  check(
    'a Sepolia contact never labels a mainnet recipient',
    findExactContact(EVM_CHAIN_ID, ETH2, [...mainnet, ...sepolia]) === null,
  );
  // The same EVM address may be saved in both modes independently.
  await addContact(SEPOLIA, 'Sepolia Alice', ETH, { store });
  check('same address saved separately per mode', (await listContacts(SEPOLIA, store)).length === 2);
  check('BTC list isolated', (await listContacts(BITCOIN_CHAIN_ID, store)).map((c) => c.name).join() === 'BTC Carol');
  check('DOGE list isolated', (await listContacts(DOGECOIN_CHAIN_ID, store)).map((c) => c.name).join() === 'DOGE Dave');
  check('SOL list isolated', (await listContacts(SOLANA_CHAIN_ID, store)).map((c) => c.name).join() === 'SOL Erin');
  // Same name on a different network is fine (names are unique per network).
  await addContact(BITCOIN_CHAIN_ID, 'Mainnet Alice', BTC2, { store });
  check('same name allowed on a different network', (await listContacts(BITCOIN_CHAIN_ID, store)).length === 2);
}

// ---------------------------------------------------------------------------
console.log('Corrupt storage (empty list + flag, never a crash, nothing overwritten):');
{
  const bad = memoryStore({ [CONTACTS_KEY]: '{not json' });
  const load = await loadContacts(EVM_CHAIN_ID, bad);
  check('bad JSON → empty list, corrupt + unreadable flags', load.contacts.length === 0 && load.corrupt && load.unreadable);
  await checkRejects(
    'writes refused while unreadable',
    () => addContact(EVM_CHAIN_ID, 'Alice', ETH, { store: bad }),
    'could not be read',
  );
  await checkRejects(
    'delete refused while unreadable',
    () => deleteContact(EVM_CHAIN_ID, ETH, bad),
    'could not be read',
  );
  check('unreadable data left untouched', bad.map.get(CONTACTS_KEY) === '{not json');
  await resetContacts(bad);
  const after = await loadContacts(EVM_CHAIN_ID, bad);
  check('explicit reset yields a clean, writable store', !after.corrupt && !after.unreadable);
  await addContact(EVM_CHAIN_ID, 'Alice', ETH, { store: bad });
  check('add works after reset', (await listContacts(EVM_CHAIN_ID, bad)).length === 1);

  const future = memoryStore({ [CONTACTS_KEY]: JSON.stringify({ version: 2, networks: {} }) });
  const f = await loadContacts(EVM_CHAIN_ID, future);
  check('unknown format version → unreadable (never clobbered by this version)', f.unreadable);

  const arr = memoryStore({ [CONTACTS_KEY]: '[]' });
  check('wrong top-level shape → unreadable', (await loadContacts(EVM_CHAIN_ID, arr)).unreadable);

  const throwing = {
    async getItem() {
      throw new Error('disk on fire');
    },
    async setItem() {
      throw new Error('should not be called');
    },
  };
  const t = await loadContacts(EVM_CHAIN_ID, throwing);
  check('storage read failure → empty + flagged, no throw', t.contacts.length === 0 && t.unreadable);

  const mixed = memoryStore({
    [CONTACTS_KEY]: JSON.stringify({
      version: 1,
      networks: {
        [EVM_CHAIN_ID]: [
          { name: 'Alice', address: ETH, createdAt: 'x' },
          { name: 'Garbage', address: '0xnothex', createdAt: 'x' },
          { name: 'Lowercase', address: ETH2.toLowerCase(), createdAt: 'x' },
          { name: 'evil‮txt.exe', address: ETH2, createdAt: 'x' },
          { name: 'Dup', address: ETH, createdAt: 'x' },
          42,
        ],
        'cosmos:cosmoshub-4': [{ name: 'Keep me', address: 'cosmos1abc' }],
      },
    }),
  });
  const m = await loadContacts(EVM_CHAIN_ID, mixed);
  check(
    'invalid entries dropped (bad address, non-normalized address, bidi name, duplicate, non-object)',
    m.contacts.length === 1 && m.contacts[0].name === 'Alice',
    JSON.stringify(m.contacts),
  );
  check('entry-level damage → corrupt flag but still writable', m.corrupt && !m.unreadable);
  await addContact(EVM_CHAIN_ID, 'Bob', ETH2, { store: mixed });
  const rewritten = JSON.parse(mixed.map.get(CONTACTS_KEY));
  check(
    'other networks’ raw entries are carried over verbatim on write',
    JSON.stringify(rewritten.networks['cosmos:cosmoshub-4']) ===
      JSON.stringify([{ name: 'Keep me', address: 'cosmos1abc' }]),
  );
  check(
    'rewritten target list holds only valid entries',
    rewritten.networks[EVM_CHAIN_ID].map((c) => c.name).join() === 'Alice,Bob',
  );
}

// ---------------------------------------------------------------------------
console.log('Exact matching only:');
{
  const contacts = [
    { networkId: EVM_CHAIN_ID, name: 'Alice', address: ETH, createdAt: '' },
    { networkId: BITCOIN_CHAIN_ID, name: 'Carol', address: BTC, createdAt: '' },
    { networkId: DOGECOIN_CHAIN_ID, name: 'Dave', address: DOGE, createdAt: '' },
    { networkId: SOLANA_CHAIN_ID, name: 'Erin', address: SOL, createdAt: '' },
  ];
  for (const form of [ETH, ETH.toLowerCase(), `0x${ETH.slice(2).toUpperCase()}`, `  ${ETH}  `]) {
    check(
      `EVM case-insensitive full-20-byte match: ${form.trim().slice(0, 8)}…`,
      matchRecipient(EVM_CHAIN_ID, form, contacts).kind === 'exact',
    );
  }
  // Flip one hex digit at many positions (first, middle, last, every 5th).
  const lower = ETH.toLowerCase();
  let oneCharNeverMatches = true;
  let tested = 0;
  for (let i = 2; i < 42; i += 1) {
    const c = lower[i];
    const replacement = c === '0' ? '1' : '0';
    const variant = lower.slice(0, i) + replacement + lower.slice(i + 1);
    if (!validateContactAddress(EVM_CHAIN_ID, variant).ok) continue;
    tested += 1;
    const r = matchRecipient(EVM_CHAIN_ID, variant, contacts);
    if (r.kind === 'exact' || findExactContact(EVM_CHAIN_ID, variant, contacts) !== null) {
      oneCharNeverMatches = false;
    }
  }
  check(`EVM: a 1-character difference never matches (all ${tested} positions)`, oneCharNeverMatches && tested === 40);

  // Solana: change one base58 character; keep only variants that still
  // decode to 32 bytes (valid addresses), and require they never match.
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let solTested = 0;
  let solOk = true;
  for (let i = 0; i < SOL.length; i += 1) {
    const replacement = alphabet[(alphabet.indexOf(SOL[i]) + 1) % 58];
    const variant = SOL.slice(0, i) + replacement + SOL.slice(i + 1);
    if (!validateContactAddress(SOLANA_CHAIN_ID, variant).ok) continue;
    solTested += 1;
    if (matchRecipient(SOLANA_CHAIN_ID, variant, contacts).kind === 'exact') solOk = false;
  }
  check(`Solana: a 1-character difference never matches (${solTested} valid variants)`, solOk && solTested > 30);
  check(
    'Solana: case matters (base58 is case-sensitive; a case-flipped key is a different key or invalid)',
    matchRecipient(SOLANA_CHAIN_ID, SOL.toLowerCase(), contacts).kind !== 'exact',
  );

  // UTXO: a one-character change breaks the checksum → invalid → no label.
  const btcVariant = BTC.slice(0, -1) + (BTC.endsWith('q') ? 'p' : 'q');
  check('Bitcoin: a 1-character difference never matches', findExactContact(BITCOIN_CHAIN_ID, btcVariant, contacts) === null);
  const dogeVariant = DOGE.slice(0, -1) + (DOGE.endsWith('a') ? 'b' : 'a');
  check('Dogecoin: a 1-character difference never matches', findExactContact(DOGECOIN_CHAIN_ID, dogeVariant, contacts) === null);
  check('Bitcoin exact match', matchRecipient(BITCOIN_CHAIN_ID, BTC, contacts).kind === 'exact');
  check('Bitcoin uppercase form of the same address matches (same output script)', matchRecipient(BITCOIN_CHAIN_ID, BTC.toUpperCase(), contacts).kind === 'exact');
  check('Dogecoin exact match', matchRecipient(DOGECOIN_CHAIN_ID, DOGE, contacts).kind === 'exact');
  check('Solana exact match', matchRecipient(SOLANA_CHAIN_ID, SOL, contacts).kind === 'exact');
  check('different real address → none', matchRecipient(DOGECOIN_CHAIN_ID, DOGE2, contacts).kind === 'none');
  check('Solana different key → none', matchRecipient(SOLANA_CHAIN_ID, SOL2, contacts).kind === 'none');
  check(
    'a contact on another chain never matches (BTC address vs DOGE contact list)',
    findExactContact(BITCOIN_CHAIN_ID, DOGE, contacts) === null,
  );
  check('invalid input → none, no throw', matchRecipient(EVM_CHAIN_ID, 'hello', contacts).kind === 'none');
  check(
    'exactMatchKey for UTXO is the output script (P2WPKH 0014…)',
    exactMatchKey(BITCOIN_CHAIN_ID, BTC).startsWith('0014') && exactMatchKey(BITCOIN_CHAIN_ID, BTC).length === 44,
  );
}

// ---------------------------------------------------------------------------
console.log('Look-alike warning (first 4 + last 4 shared, address different):');
{
  const contacts = [
    { networkId: EVM_CHAIN_ID, name: 'Alice', address: ETH, createdAt: '' },
    { networkId: SOLANA_CHAIN_ID, name: 'Erin', address: SOL, createdAt: '' },
    { networkId: BITCOIN_CHAIN_ID, name: 'Carol', address: BTC, createdAt: '' },
  ];
  // EVM poison: same first 4 / last 4 characters, different middle.
  const lower = ETH.toLowerCase();
  const poison = lower.slice(0, 6) + 'deadbeef'.repeat(4) + lower.slice(-2);
  const poisonFixed = poison.slice(0, 42 - 4) + lower.slice(-4);
  check('constructed EVM poison address is valid', validateContactAddress(EVM_CHAIN_ID, poisonFixed).ok);
  check(
    'constructed poison shares first4/last4 but differs',
    poisonFixed.slice(0, 4) === lower.slice(0, 4) && poisonFixed.slice(-4) === lower.slice(-4) && poisonFixed !== lower,
  );
  const m = matchRecipient(EVM_CHAIN_ID, poisonFixed, contacts);
  check('EVM look-alike → warning, never a label', m.kind === 'lookalike' && m.contacts[0].name === 'Alice');
  check(
    'warning text is exact',
    lookalikeWarning(m.contacts) ===
      'This address looks similar to your contact “Alice” but is DIFFERENT. Check every character.',
    lookalikeWarning(m.contacts),
  );
  check(
    'uppercase poison also warns (case-insensitive look-alike check)',
    matchRecipient(EVM_CHAIN_ID, `0x${poisonFixed.slice(2).toUpperCase()}`, contacts).kind === 'lookalike',
  );
  check('exact match NEVER warns', matchRecipient(EVM_CHAIN_ID, ETH, contacts).kind === 'exact' && findLookalikes(EVM_CHAIN_ID, ETH, contacts).length === 0);
  check('exact match in another case NEVER warns', findLookalikes(EVM_CHAIN_ID, ETH.toLowerCase(), contacts).length === 0);
  const onlyPrefix = lower.slice(0, 10) + '0'.repeat(32);
  check('same prefix only → none', matchRecipient(EVM_CHAIN_ID, onlyPrefix, contacts).kind === 'none');
  const onlySuffix = '0x' + '0'.repeat(36) + lower.slice(-4);
  check('same suffix only → none', matchRecipient(EVM_CHAIN_ID, onlySuffix, contacts).kind === 'none');
  check('Sepolia recipient never warns about a mainnet contact', findLookalikes(SEPOLIA, poisonFixed, contacts).length === 0);

  // Solana poison: N + k·58^4 keeps the last four base58 digits and, for a
  // small k, the leading digits; must still be 32 bytes.
  const n = BigInt('0x' + Buffer.from(base58.decode(SOL)).toString('hex'));
  const p = n + 58n ** 4n * 1000003n;
  const pBytes = Uint8Array.from(Buffer.from(p.toString(16).padStart(64, '0'), 'hex'));
  const solPoison = base58.encode(pBytes);
  check(
    'constructed Solana poison: valid, first4/last4 shared, different',
    validateContactAddress(SOLANA_CHAIN_ID, solPoison).ok &&
      solPoison.slice(0, 4) === SOL.slice(0, 4) &&
      solPoison.slice(-4) === SOL.slice(-4) &&
      solPoison !== SOL,
    `${SOL} vs ${solPoison}`,
  );
  check('Solana look-alike → warning', matchRecipient(SOLANA_CHAIN_ID, solPoison, contacts).kind === 'lookalike');

  // Bitcoin poison: search P2WPKH programs until the bech32 string ends in
  // the same four characters (the first four, "bc1q", are shared by every
  // P2WPKH address). Bounded search; ~32^4 = 1,048,576 expected tries.
  let btcPoison = null;
  const target = BTC.slice(-4);
  const program = new Uint8Array(20);
  for (let i = 0; i < 8_000_000 && btcPoison === null; i += 1) {
    program[0] = i & 0xff;
    program[1] = (i >>> 8) & 0xff;
    program[2] = (i >>> 16) & 0xff;
    program[3] = (i >>> 24) & 0xff;
    const addr = bech32.encode('bc', [0, ...bech32.toWords(program)]);
    if (addr.endsWith(target)) btcPoison = addr;
  }
  check('constructed Bitcoin poison found and valid', btcPoison !== null && validateContactAddress(BITCOIN_CHAIN_ID, btcPoison).ok, String(btcPoison));
  if (btcPoison) {
    check('Bitcoin look-alike → warning', matchRecipient(BITCOIN_CHAIN_ID, btcPoison, contacts).kind === 'lookalike');
  }

  // Adding a look-alike contact needs explicit acknowledgement.
  const store = memoryStore();
  await addContact(EVM_CHAIN_ID, 'Alice', ETH, { store });
  const snapshot = store.map.get(CONTACTS_KEY);
  const err = await checkRejects(
    'saving a look-alike of an existing contact is refused by default',
    () => addContact(EVM_CHAIN_ID, 'Totally Alice', poisonFixed, { store }),
    'looks similar to your contact “Alice”',
  );
  check('the refusal is a LookalikeContactError', err instanceof LookalikeContactError);
  check('nothing persisted by the refused look-alike save', store.map.get(CONTACTS_KEY) === snapshot);
  await addContact(EVM_CHAIN_ID, 'Totally Alice', poisonFixed, { store, acknowledgeLookalike: true });
  check('saved after explicit acknowledgement', (await listContacts(EVM_CHAIN_ID, store)).length === 2);
}

// ---------------------------------------------------------------------------
console.log('Name sanitization (anti-spoofing):');
{
  const s = (x) => sanitizeContactName(x);
  check('trim', s('  Alice  ').name === 'Alice');
  check('RLO bidi override stripped', s('evil‮gnp.exe').name === 'evilgnp.exe');
  check(
    'all embeddings/overrides/isolates/marks stripped',
    s('‪A‫B‬C‭D‮E⁦F⁧G⁨H⁩I‎J‏K؜L').name === 'ABCDEFGHIJKL',
  );
  check('C0/C1 control characters stripped', s('Al\u0000i\u0007c\u001Fe\u007F\u0085\u009F').name === 'Alice');
  check('newline/tab collapse to one space', s('Alice\n\t Smith').name === 'Alice Smith');
  check('zero-width space / word joiner / BOM stripped', s('Al​i⁠c﻿e').name === 'Alice');
  check('line/paragraph separators collapse to a space', s('A B C').name === 'A B C');
  check('ZWJ kept (emoji sequences need it)', s('\u{1F468}‍\u{1F4BB} Dev').name === '\u{1F468}‍\u{1F4BB} Dev');
  check('NFC normalization (e + combining acute → é)', s('José').name === 'José');
  check('only-invisible name → refused', !s('‮​ ⁦').ok);
  check('40 characters accepted', s('a'.repeat(40)).ok);
  check('41 characters refused', !s('a'.repeat(41)).ok);
  check('40 emoji (code points) accepted', s('\u{1F415}'.repeat(40)).ok);
  const store = memoryStore();
  const saved = await addContact(EVM_CHAIN_ID, ' ‮Mallory‬ ', ETH, { store });
  check('stored name is the sanitized one', saved.name === 'Mallory');
}

// ---------------------------------------------------------------------------
console.log('Rename / delete:');
{
  const store = memoryStore();
  await addContact(EVM_CHAIN_ID, 'Alice', ETH, { store });
  await addContact(EVM_CHAIN_ID, 'Bob', ETH2, { store });
  const r = await renameContact(EVM_CHAIN_ID, ETH.toLowerCase(), '  Alice ‮W ', store);
  check('rename by exact address (any case) with sanitization', r.name === 'Alice W' && r.address === ETH);
  await checkRejects('rename to an existing name refused', () => renameContact(EVM_CHAIN_ID, ETH, 'BOB', store), '“Bob”');
  await checkRejects('rename of a missing contact refused', () => renameContact(EVM_CHAIN_ID, '0x' + '1'.repeat(40), 'Z', store), 'no longer exists');
  await checkRejects('rename to empty refused', () => renameContact(EVM_CHAIN_ID, ETH, '​', store), 'Enter a name');
  check('rename to own name in another case allowed', (await renameContact(EVM_CHAIN_ID, ETH, 'alice w', store)).name === 'alice w');
  check('delete returns true', (await deleteContact(EVM_CHAIN_ID, ETH, store)) === true);
  check('delete again returns false', (await deleteContact(EVM_CHAIN_ID, ETH, store)) === false);
  const left = await listContacts(EVM_CHAIN_ID, store);
  check('only Bob remains', left.length === 1 && left[0].name === 'Bob');
  const lookalikeOfBob = '0x' + ETH2.slice(2, 4).toLowerCase() + '0'.repeat(34) + ETH2.slice(-4).toLowerCase();
  check(
    'delete never removes a look-alike (exact only)',
    validateContactAddress(EVM_CHAIN_ID, lookalikeOfBob).ok &&
      (await deleteContact(EVM_CHAIN_ID, lookalikeOfBob, store)) === false &&
      (await listContacts(EVM_CHAIN_ID, store)).length === 1,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

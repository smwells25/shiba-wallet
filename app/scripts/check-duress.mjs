// Duress wallet, Stage 2 (docs/DURESS_WALLET.md sections 6 and 7): the
// opt-in app PIN (src/wallet/pin.ts), the duress PIN and its decoy wallet
// (src/wallet/duress.ts), the active storage profile (store-keys.ts), the
// PIN mode of the lock gate (lock.ts, LockGate.tsx) and the rules the
// screens must keep (WalletContext.tsx, PrefsContext.tsx, SettingsScreen.tsx).
//
// Pinned here:
//  - the PIN record has the same shape and byte length with and without a
//    duress PIN (the length is a literal);
//  - every attempt computes BOTH slot hashes (a counting KDF, independent of
//    timing), whichever PIN was typed, malformed ones included;
//  - the wait schedule (5 free, 30 s, doubling to 1 h, no wipe), honoured
//    after a restart, and the counter written BEFORE the hashes;
//  - the real scrypt parameters (N = 2^16, r = 8, p = 1, 32-byte salt and
//    hash), recomputed independently;
//  - the profile prefix on wallet and secret keys and never on device keys;
//    the PIN record always under its primary name;
//  - the decoy phrase equals an independent BIP-85 derivation of the parent
//    (and the official 12-word vector through the core module);
//  - with the decoy open, zero reads of the real wallet's secrets;
//  - "Remove wallet" deletes every key of both profiles (enumerated);
//  - the active profile is never written to any store;
//  - notifications are refused while a PIN exists;
//  - the PIN never appears in any store or log;
//  - the lock gate's PIN mode;
//  - each rule's mutant is caught.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-duress.mjs
//
// No device, no network.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import * as seam from '../src/wallet/store-keys.ts';
import * as pinMod from '../src/wallet/pin.ts';
import * as duressMod from '../src/wallet/duress.ts';
import * as lockMod from '../src/wallet/lock.ts';
import * as storage from '../src/wallet/storage.ts';
import * as core from '@shiba-wallet/core';

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

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake expo-secure-store: items keyed by service + key; every access logged. */
function fakeSecureStore() {
  const items = new Map();
  const log = [];
  const id = (k, o) => `${o?.keychainService ?? 'default'}|${k}`;
  return {
    items,
    log,
    getItemAsync: async (k, o) => {
      log.push(['get', k, o?.keychainService ?? 'default']);
      return items.has(id(k, o)) ? items.get(id(k, o)) : null;
    },
    setItemAsync: async (k, v, o) => {
      log.push(['set', k, o?.keychainService ?? 'default']);
      items.set(id(k, o), v);
    },
    deleteItemAsync: async (k, o) => {
      log.push(['delete', k, o?.keychainService ?? 'default']);
      items.delete(id(k, o));
    },
    canUseBiometricAuthentication: () => false,
    whenUnlockedThisDeviceOnly: 6,
  };
}

/** A fake AsyncStorage with the methods the wipe uses. */
function fakeAsyncStore() {
  const map = new Map();
  const log = [];
  return {
    map,
    log,
    getItem: async (k) => {
      log.push(['get', k]);
      return map.has(k) ? map.get(k) : null;
    },
    setItem: async (k, v) => {
      log.push(['set', k]);
      map.set(k, v);
    },
    removeItem: async (k) => {
      log.push(['remove', k]);
      map.delete(k);
    },
    getAllKeys: async () => [...map.keys()],
  };
}

/** A fast, counting KDF stand-in (sha256(salt ‖ pin)); the real scrypt is pinned separately. */
function countingKdf() {
  const calls = [];
  const kdf = async (pin, salt) => {
    calls.push(pin);
    return sha256(concatBytes(salt, utf8ToBytes(pin)));
  };
  return { kdf, calls };
}

let seed = 1;
function detRandom(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

const PARENT_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PARENT_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
// The children of the two public reference phrases, pinned by a SHA-256
// fingerprint (computed on 2026-10-14) and by an independent derivation
// below — not as literal words, because the repository's pre-commit secret
// scan refuses any checksum-valid BIP-39 phrase (scripts/githooks/
// secret-scan.mjs), and these derived phrases are not on its allow list.
const CHILD_12_SHA256 = 'db04acf46c00617f0f7ab0fcc5601a878f9bdbb4348b99b6558beff79bec1528';
const CHILD_24_SHA256 = '3a98868124023d3d94b0f93f5e92daa9e3161f82316fbf7890c83a880ddd15e7';
// BIP-85's official 12-word vector, by its derived entropy and the SHA-256 of
// the specification's mnemonic text (bitcoin/bips 62097686).
const VECTOR_12_ENTROPY = '6250b68daf746d12a24d58b4787a714b';
const VECTOR_12_SHA256 = 'e285fb84baf748609438a466fba70eb2b6015102935916538252d3d12e39db3b';
const sha256Hex = (text) => bytesToHex(sha256(utf8ToBytes(text)));

const PIN_A = '482913';
const PIN_B = '730561';

// ---------------------------------------------------------------------------
// Test bodies (each takes the modules, so the mutants run the same body)
// ---------------------------------------------------------------------------

async function recordShape(pin) {
  const { kdf } = countingKdf();
  const only = await pin.createPinRecord(PIN_A, { kdf, random: detRandom });
  const backend = fakeSecureStore();
  await pin.writePinRecord(backend, only);
  const rawOnly = [...backend.items.values()][0];
  await pin.setPinSlot(backend, 'duress', PIN_B, { kdf, random: detRandom });
  const rawBoth = [...backend.items.values()][0];
  const keys = (r) => Object.keys(JSON.parse(r)).sort().join(',');
  return {
    lengthOnly: rawOnly.length,
    lengthBoth: rawBoth.length,
    sameKeys: keys(rawOnly) === keys(rawBoth),
    slotLengths: JSON.parse(rawBoth).slots.map((s) => s.length),
    differ: rawOnly !== rawBoth,
  };
}

async function hashCounts(pin) {
  const { kdf, calls } = countingKdf();
  const backend = fakeSecureStore();
  await pin.writePinRecord(backend, await pin.createPinRecord(PIN_A, { kdf, random: detRandom }));
  await pin.setPinSlot(backend, 'duress', PIN_B, { kdf, random: detRandom });
  const counts = {};
  for (const [label, typed] of [['primary', PIN_A], ['duress', PIN_B], ['wrong', '111112'], ['malformed', '12a']]) {
    calls.length = 0;
    const out = await pin.attemptPin(backend, typed, { kdf, random: detRandom, now: () => 1_000 });
    counts[label] = { calls: calls.length, kind: out.kind, slot: out.slot ?? null };
  }
  return counts;
}

async function schedule(pin) {
  const { kdf, calls } = countingKdf();
  const backend = fakeSecureStore();
  let now = 10_000;
  const deps = { kdf, random: detRandom, now: () => now };
  await pin.writePinRecord(backend, await pin.createPinRecord(PIN_A, deps));
  const seen = [];
  for (let i = 1; i <= 13; i += 1) {
    const out = await pin.attemptPin(backend, '000001', deps);
    seen.push(out.kind === 'wrong' ? (out.until === 0 ? 0 : out.until - now) : out.kind);
    if (out.kind === 'wrong' && out.until > now) {
      // During the wait: refused with no hash computed.
      calls.length = 0;
      const during = await pin.attemptPin(backend, PIN_A, deps);
      seen.push(`during:${during.kind}:${calls.length}`);
      // A restart reads the same record: the wait is still honoured.
      const restarted = await pin.attemptPin(backend, PIN_A, { ...deps });
      seen.push(`restart:${restarted.kind}`);
      now = out.until;
    }
  }
  const ok = await pin.attemptPin(backend, PIN_A, deps);
  const after = await pin.readPinRecord(backend);
  return { seen, ok: ok.kind, resetFails: after.fails, resetUntil: after.until };
}

async function preIncrement(pin) {
  const backend = fakeSecureStore();
  const { kdf } = countingKdf();
  await pin.writePinRecord(backend, await pin.createPinRecord(PIN_A, { kdf, random: detRandom }));
  const dying = async () => {
    throw new Error('app killed during the hash');
  };
  await pin.attemptPin(backend, PIN_A, { kdf: dying, random: detRandom, now: () => 5 }).catch(() => undefined);
  return (await pin.readPinRecord(backend)).fails;
}

async function expectSlot(pin) {
  const backend = fakeSecureStore();
  const { kdf } = countingKdf();
  const deps = { kdf, random: detRandom, now: () => 1 };
  await pin.writePinRecord(backend, await pin.createPinRecord(PIN_A, deps));
  await pin.setPinSlot(backend, 'duress', PIN_B, deps);
  await pin.attemptPin(backend, '999990', deps);
  const other = await pin.attemptPin(backend, PIN_A, deps, 'duress');
  const fails = (await pin.readPinRecord(backend)).fails;
  const own = await pin.attemptPin(backend, PIN_B, deps, 'duress');
  return { other: other.kind, failsAfterOther: fails, own: own.kind, failsAfterOwn: (await pin.readPinRecord(backend)).fails };
}

function profileKeys(sm) {
  const decoy = duressMod.DECOY_STORE_PROFILE;
  const rows = Object.values(sm.STORE_KEYS).map((d) => {
    const k = d.match === 'prefix' ? `${d.name}0` : d.name;
    return { k, scope: d.scope, scoped: sm.scopedStoreKey(k, decoy) };
  });
  return {
    device: rows.filter((r) => r.scope === 'device'),
    other: rows.filter((r) => r.scope !== 'device'),
  };
}

// ---------------------------------------------------------------------------
console.log('check-duress: the PIN record (src/wallet/pin.ts)');
// ---------------------------------------------------------------------------
{
  const shape = await recordShape(pinMod);
  check('the record has the same byte length with and without a duress PIN: 358 bytes, pinned',
    shape.lengthOnly === 358 && shape.lengthBoth === 358 && pinMod.PIN_RECORD_LENGTH === 358, JSON.stringify(shape));
  check('…and the same keys, two 64-byte slots either way (128 hex characters each), while the content changed',
    shape.sameKeys && shape.slotLengths.join(',') === '128,128' && shape.differ);
  check('the KDF parameters: scrypt N = 2^16, r = 8, p = 1, 32-byte salt and hash (N fixed by the Node measurement in pin.ts)',
    pinMod.PIN_SCRYPT.N === 65536 && pinMod.PIN_SCRYPT.r === 8 && pinMod.PIN_SCRYPT.p === 1 && pinMod.PIN_SCRYPT.dkLen === 32 &&
      pinMod.PIN_SALT_BYTES === 32 && pinMod.PIN_HASH_BYTES === 32);

  // One real scrypt record, recomputed independently.
  const real = await pinMod.createPinRecord(PIN_A, { random: detRandom });
  const salt = real.slots[0].subarray(0, 32);
  const independent = scrypt(PIN_A, salt, { N: 2 ** 16, r: 8, p: 1, dkLen: 32 });
  check('the real slot hash equals scrypt(PIN, salt, N = 2^16, r = 8, p = 1, dkLen = 32) computed here independently',
    bytesToHex(real.slots[0].subarray(32)) === bytesToHex(independent));
  const realBackend = fakeSecureStore();
  await pinMod.writePinRecord(realBackend, real);
  const realOpen = await pinMod.attemptPin(realBackend, PIN_A, { random: detRandom });
  const realWrong = await pinMod.attemptPin(realBackend, '000000', { random: detRandom });
  check('…and the real KDF opens the primary slot with that PIN and refuses another', realOpen.kind === 'opened' && realOpen.slot === 'primary' && realWrong.kind === 'wrong');

  check('the record decodes back exactly, and a damaged record is refused (never read as "no PIN")',
    (() => {
      const enc = pinMod.encodePinRecord(real);
      const dec = pinMod.decodePinRecord(enc);
      let damaged = false;
      try { pinMod.decodePinRecord(enc.replace('"fails":"', '"fails":"1')); } catch (e) { damaged = e instanceof pinMod.PinRecordDamagedError; }
      return bytesToHex(dec.slots[0]) === bytesToHex(real.slots[0]) && damaged;
    })());
  check('the PIN rules: exactly 6 digits; all one digit, 123456 and 654321 are refused as new PINs',
    pinMod.pinFormatError('12345') === pinMod.PIN_FORMAT_MESSAGE && pinMod.pinFormatError('１２３４５６') !== null && pinMod.pinFormatError('482913') === null &&
      ['000000', '777777', '123456', '654321'].every(pinMod.isTriviallyGuessed) && !pinMod.isTriviallyGuessed('482913'));
  check('constant-time comparison: equal and unequal arrays, and the loop has no early return (source)',
    pinMod.equalBytesConstantTime(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])) &&
      !pinMod.equalBytesConstantTime(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])) &&
      /for \(let i = 0; i < a\.length; i \+= 1\) diff \|= a\[i\] \^ b\[i\];\n\s*return diff === 0;/.test(read('wallet/pin.ts')));
}

// ---------------------------------------------------------------------------
console.log('check-duress: every attempt computes BOTH hashes (a counter, not a clock)');
// ---------------------------------------------------------------------------
{
  const c = await hashCounts(pinMod);
  check('primary PIN: 2 hashes, opens the primary slot', c.primary.calls === 2 && c.primary.kind === 'opened' && c.primary.slot === 'primary', JSON.stringify(c.primary));
  check('duress PIN: 2 hashes, opens the duress slot', c.duress.calls === 2 && c.duress.kind === 'opened' && c.duress.slot === 'duress', JSON.stringify(c.duress));
  check('wrong PIN: 2 hashes', c.wrong.calls === 2 && c.wrong.kind === 'wrong', JSON.stringify(c.wrong));
  check('malformed PIN: still 2 hashes (no faster answer)', c.malformed.calls === 2 && c.malformed.kind === 'wrong', JSON.stringify(c.malformed));
  check('a duress PIN equal to the app PIN is refused, with the same sentence as a trivially guessed PIN',
    await (async () => {
      const b = fakeSecureStore();
      const { kdf } = countingKdf();
      await pinMod.writePinRecord(b, await pinMod.createPinRecord(PIN_A, { kdf, random: detRandom }));
      try { await pinMod.setPinSlot(b, 'duress', PIN_A, { kdf, random: detRandom }); return false; } catch (e) { return e.message === pinMod.PIN_NOT_USABLE_MESSAGE; }
    })());
  const e = await expectSlot(pinMod);
  check('Settings "current PIN": the other wallet\'s PIN counts as wrong and does NOT reset the counter; the open wallet\'s PIN does',
    e.other === 'wrong' && e.failsAfterOther === 2 && e.own === 'opened' && e.failsAfterOwn === 0, JSON.stringify(e));
}

// ---------------------------------------------------------------------------
console.log('check-duress: the wait schedule (section 6.3)');
// ---------------------------------------------------------------------------
const EXPECTED_SCHEDULE = [
  0, 0, 0, 0,
  30_000, 'during:wait:0', 'restart:wait',
  60_000, 'during:wait:0', 'restart:wait',
  120_000, 'during:wait:0', 'restart:wait',
  240_000, 'during:wait:0', 'restart:wait',
  480_000, 'during:wait:0', 'restart:wait',
  960_000, 'during:wait:0', 'restart:wait',
  1_920_000, 'during:wait:0', 'restart:wait',
  3_600_000, 'during:wait:0', 'restart:wait',
  3_600_000, 'during:wait:0', 'restart:wait',
];
{
  const s = await schedule(pinMod);
  check('5 wrong PINs → 30 s, then doubling to a 1-hour cap; refused during the wait with no hash computed; a restart honours it',
    JSON.stringify(s.seen) === JSON.stringify(EXPECTED_SCHEDULE), JSON.stringify(s.seen));
  check('a correct PIN after the wait opens and resets the counter and the wait (no wipe at any count)', s.ok === 'opened' && s.resetFails === 0 && s.resetUntil === 0);
  check('waitAfterFailures: 0 for 0–4, 30 s at 5, 1 h from 12 on', [0, 1, 4].every((n) => pinMod.waitAfterFailures(n) === 0) &&
    pinMod.waitAfterFailures(5) === 30_000 && pinMod.waitAfterFailures(11) === 1_920_000 && pinMod.waitAfterFailures(12) === 3_600_000 && pinMod.waitAfterFailures(400) === 3_600_000);
  check('the counter is written BEFORE the hashes: an attempt killed mid-hash still counts', (await preIncrement(pinMod)) === 1);
  check('the lock screen\'s sentences: "Wrong PIN. Try again." and the wait in seconds or minutes, the same whichever wallet',
    pinMod.pinAttemptMessage({ kind: 'wrong', fails: 1, until: 0 }, 0) === 'Wrong PIN. Try again.' &&
      pinMod.pinAttemptMessage({ kind: 'wrong', fails: 5, until: 30_000 }, 0) === 'Wrong PIN. Try again in 30 seconds.' &&
      pinMod.pinAttemptMessage({ kind: 'wait', until: 3_600_000 }, 0) === 'Too many wrong PINs. Try again in 60 minutes.');
}

// ---------------------------------------------------------------------------
console.log('check-duress: the storage profiles (store-keys.ts)');
// ---------------------------------------------------------------------------
{
  const { device, other } = profileKeys(seam);
  check(`the decoy profile prefix is applied to every wallet and secret key (${other.length})`,
    other.every((r) => r.scoped === `shiba-wallet.profile-w2.${r.k.slice('shiba-wallet.'.length)}`));
  check(`…and to no device key (${device.length})`, device.length === 9 && device.every((r) => r.scoped === r.k));
  check('parseStoredKeyName reverses it (and refuses a prefixed device key)',
    other.every((r) => { const p = seam.parseStoredKeyName(r.scoped); return p?.keyPrefix === 'w2' && p.key === r.k; }) &&
      seam.parseStoredKeyName('shiba-wallet.profile-w2.prefs.v1') === null && seam.parseStoredKeyName('shiba-wallet.accounts.v1')?.keyPrefix === null);

  const store = fakeAsyncStore();
  seam.setActiveStoreProfile(duressMod.DECOY_STORE_PROFILE);
  await seam.writeStoreItem(store, 'shiba-wallet.contacts.v1', '{}');
  await seam.writeStoreItem(store, 'shiba-wallet.prefs.v1', '{}');
  const backend = fakeSecureStore();
  await pinMod.writePinRecord(backend, await pinMod.createPinRecord(PIN_A, { kdf: countingKdf().kdf, random: detRandom }));
  seam.setActiveStoreProfile(seam.PRIMARY_STORE_PROFILE);
  check('with the decoy active, a wallet key is written under its prefix and a device key under its own name',
    store.map.has('shiba-wallet.profile-w2.contacts.v1') && store.map.has('shiba-wallet.prefs.v1') && !store.map.has('shiba-wallet.contacts.v1'));
  check('…and the PIN record always under its primary name (bound to the primary profile)',
    [...backend.items.keys()].join(',') === 'default|shiba-wallet.app-lock.v1');
  const bound = seam.profileBoundStore(store, duressMod.DECOY_STORE_PROFILE);
  await seam.writeStoreItem(bound, 'shiba-wallet.notes.v1'.replace('notes', 'tx-notes'), '{}');
  check('a store bound to a profile uses it whatever profile is active', store.map.has('shiba-wallet.profile-w2.tx-notes.v1'));
  check('the decoy profile maps to the duress slot, the primary to the primary slot',
    duressMod.profileForSlot('duress') === duressMod.DECOY_STORE_PROFILE && duressMod.profileForSlot('primary') === seam.PRIMARY_STORE_PROFILE);
}

// ---------------------------------------------------------------------------
console.log('check-duress: the decoy phrase (BIP-85, index 0)');
// ---------------------------------------------------------------------------
/** BIP-85 BIP39 application, re-implemented here from the specification. */
function independentChild(parent, words) {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(parent, ''));
  const k = root.derive(`m/83696968'/39'/0'/${words}'/0'`).privateKey;
  const entropy = hmac(sha512, utf8ToBytes('bip-entropy-from-k'), k);
  return entropyToMnemonic(entropy.slice(0, (words / 3) * 4), wordlist);
}
async function decoyPhrases(dm) {
  return { c12: dm.deriveDecoyPhrase(PARENT_12), c24: dm.deriveDecoyPhrase(PARENT_24) };
}
{
  const { c12, c24 } = await decoyPhrases(duressMod);
  check('decoy of the 12-word reference phrase = the independent BIP-85 derivation = the pinned fingerprint (12 words)',
    c12 === independentChild(PARENT_12, 12) && sha256Hex(c12) === CHILD_12_SHA256 && c12.split(' ').length === 12);
  check('decoy of a 24-word phrase keeps 24 words and matches too', c24 === independentChild(PARENT_24, 24) && sha256Hex(c24) === CHILD_24_SHA256);
  const vector = core.bip85MnemonicFromRoot(
    HDKey.fromExtendedKey('xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb'),
    12,
    0,
  );
  check('the core module the app uses reproduces BIP-85\'s official 12-word vector (its entropy and its published words)',
    vector === entropyToMnemonic(hexToBytes(VECTOR_12_ENTROPY), wordlist) && sha256Hex(vector) === VECTOR_12_SHA256);
  check('the child index is fixed at 0 for every user (nothing to write down or store)', duressMod.DECOY_BIP85_INDEX === 0);
}

// ---------------------------------------------------------------------------
console.log('check-duress: with the decoy open, zero reads of the real wallet\'s secrets');
// ---------------------------------------------------------------------------
async function decoyIsolation(dm) {
  const backend = fakeSecureStore();
  const primaryVault = storage.createKeyVault(seam.profileBoundSecureBackend(backend, seam.PRIMARY_STORE_PROFILE), { policy: 'off' });
  await primaryVault.saveNewPhrase(PARENT_12);
  await dm.setUpDecoyWallet(PARENT_12, storage.createKeyVault(seam.profileBoundSecureBackend(backend, dm.DECOY_STORE_PROFILE), { policy: 'off' }));
  const appVault = storage.createKeyVault(backend, { policy: 'off' });
  seam.setActiveStoreProfile(dm.profileForSlot('duress'));
  backend.log.length = 0;
  const phrase = await appVault.readPhrase('Reveal recovery phrase');
  await appVault.openPhraseForApproval('Unlock Shiba Wallet');
  await appVault.importedKeys.list();
  await appVault.status();
  const touched = backend.log.map(([, k]) => k);
  seam.setActiveStoreProfile(seam.PRIMARY_STORE_PROFILE);
  return { phrase, touched };
}
{
  const { phrase, touched } = await decoyIsolation(duressMod);
  check('the app vault, with the decoy active, reveals the DECOY phrase (the BIP-85 child)', phrase === independentChild(PARENT_12, 12));
  check(`…and touched ${touched.length} secure-store items, every one under the decoy prefix: none of the real wallet`,
    touched.length > 0 && touched.every((k) => k.startsWith('shiba-wallet.profile-w2.')), JSON.stringify(touched));
}

// ---------------------------------------------------------------------------
console.log('check-duress: "Remove wallet" with an app PIN removes BOTH wallets');
// ---------------------------------------------------------------------------
const { forgetAllSessions } = await import('../src/wallet/sessions.ts');
const { resetAccounts, addAccount } = await import('../src/wallet/accounts.ts');
const { addContact } = await import('../src/wallet/contacts.ts');
async function wipeBoth(dm) {
  const backend = fakeSecureStore();
  const store = fakeAsyncStore();
  const vaultFor = (p) => storage.createKeyVault(seam.profileBoundSecureBackend(backend, p), { policy: 'off' });
  const IMPORTED = `0x${'11'.repeat(32)}`;
  for (const [p, phrase] of [[seam.PRIMARY_STORE_PROFILE, PARENT_12], [dm.DECOY_STORE_PROFILE, independentChild(PARENT_12, 12)]]) {
    const v = vaultFor(p);
    await v.saveNewPhrase(phrase);
    await v.savePublicAccount(0, [{ chainId: 'eip155:1', address: '0x52908400098527886E0F7030069857D2E4169EE7', path: "m/44'/60'/0'/0/0" }]);
    await v.importedKeys.save(IMPORTED, storage.addressOfImportedKey(IMPORTED));
    const bs = seam.profileBoundStore(store, p);
    await addAccount(null, bs);
    await addContact('eip155:1', `Pin ${p.id}`, '0x52908400098527886E0F7030069857D2E4169EE7', { store: bs });
    await seam.writeStoreItem(bs, 'shiba-wallet.tokens.v1.eip155:11155111', '[]');
  }
  await seam.writeStoreItem(store, 'shiba-wallet.prefs.v1', '{"hideAmounts":true}');
  await seam.writeStoreItem(store, 'shiba-wallet.custom-networks.v1', '[]');
  await pinMod.writePinRecord(backend, await pinMod.createPinRecord(PIN_A, { kdf: countingKdf().kdf, random: detRandom }));
  const before = { secure: [...backend.items.keys()], async: [...store.map.keys()] };
  seam.setActiveStoreProfile(dm.DECOY_STORE_PROFILE); // removed from inside the decoy
  dm.appPinPresence.set(true);
  await dm.wipeBothWallets({
    store,
    backend,
    vaultFor,
    resetRecords: async (bs, v) => {
      await forgetAllSessions(bs, v.sessionKeys);
      await resetAccounts(bs);
    },
    publicAccountIndices: [0, 1, 2],
  });
  return {
    before,
    after: { secure: [...backend.items.keys()], async: [...store.map.keys()] },
    active: seam.activeStoreProfile(),
    presence: dm.appPinPresence.get(),
  };
}
{
  const w = await wipeBoth(duressMod);
  const secureBefore = w.before.secure.map((k) => k.split('|')[1]).sort();
  check(`before: both wallets stored (${w.before.secure.length} secure items, ${w.before.async.length} records), e.g. both phrases and both imported keys`,
    ['shiba-wallet.mnemonic.v1', 'shiba-wallet.profile-w2.mnemonic.v1', 'shiba-wallet.imported-key.v1.0', 'shiba-wallet.profile-w2.imported-key.v1.0',
      'shiba-wallet.public-account.v1.0', 'shiba-wallet.profile-w2.public-account.v1.0', 'shiba-wallet.app-lock.v1'].every((k) => secureBefore.includes(k)),
    JSON.stringify(secureBefore));
  console.log(`       secure items removed: ${secureBefore.join(', ')}`);
  console.log(`       records removed: ${w.before.async.filter((k) => !w.after.async.includes(k)).sort().join(', ')}`);
  check('after: no secure-store item of either wallet is left, and the PIN record is gone', w.after.secure.length === 0, JSON.stringify(w.after.secure));
  check('after: only the device settings remain in AsyncStorage (preferences, networks the user added)',
    JSON.stringify(w.after.async.sort()) === JSON.stringify(['shiba-wallet.custom-networks.v1', 'shiba-wallet.prefs.v1']), JSON.stringify(w.after.async));
  check('after: the active profile is the primary one again and no PIN is set', w.active === seam.PRIMARY_STORE_PROFILE && w.presence === false);
  const ctx = read('wallet/WalletContext.tsx');
  check('WalletContext: the wipe takes this path whenever an app PIN is set, with the same resets as the ordinary wipe (sessions with their keys first)',
    /if \(appPinPresence\.get\(\)\) \{/.test(ctx) && /await forgetAllSessions\(store, vault\.sessionKeys\)/.test(ctx) &&
      ['wipeRecoveryData(store)', 'resetPasskeys(store)', 'resetSpendingLimits(store)', 'forgetBrowserConnections(store)', 'wipeTransactionNotes(store)',
        'resetMultisigRecords(store)', 'resetPendingRegistry(store)', 'resetPriceAlerts(store)', 'resetAccounts(store)'].every((c) => ctx.includes(`await ${c}`)) &&
      ctx.indexOf('if (appPinPresence.get()) {') < ctx.indexOf('await importedKeyVault.removeAll();'));
  check('secureKeyNamesOf enumerates the fixed secret names of a profile (phrase ×2, vault meta, imported record, public cache, imported keys ×2)',
    duressMod.secureKeyNamesOf(2, 1).join(',') ===
      'shiba-wallet.mnemonic.v1,shiba-wallet.mnemonic.v2,shiba-wallet.vault-meta.v1,shiba-wallet.imported-keys.v1,shiba-wallet.public-account.v1.0,shiba-wallet.public-account.v1.1,shiba-wallet.imported-key.v1.0,shiba-wallet.imported-key.v2.0');
}

// ---------------------------------------------------------------------------
console.log('check-duress: the active profile is never stored; the PIN never stored or logged');
// ---------------------------------------------------------------------------
{
  // A whole set-up and use, with console captured.
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map(String).join(' '));
  const backend = fakeSecureStore();
  const store = fakeAsyncStore();
  let w;
  try {
    const deps = { random: detRandom };
    await pinMod.setAppPin(backend, PIN_A, deps);
    await duressMod.setUpDecoyWallet(PARENT_12, storage.createKeyVault(seam.profileBoundSecureBackend(backend, duressMod.DECOY_STORE_PROFILE), { policy: 'off' }));
    await pinMod.setPinSlot(backend, 'duress', PIN_B, deps);
    const opened = await pinMod.attemptPin(backend, PIN_B, deps);
    seam.setActiveStoreProfile(duressMod.profileForSlot(opened.slot));
    await addContact('eip155:1', 'Shop', '0x52908400098527886E0F7030069857D2E4169EE7', { store });
    await pinMod.attemptPin(backend, '123123', deps);
    seam.setActiveStoreProfile(seam.PRIMARY_STORE_PROFILE);
    w = { opened };
  } finally {
    Object.assign(console, orig);
  }
  const everything = [
    ...[...backend.items.entries()].flat(),
    ...[...store.map.entries()].flat(),
    ...logged,
  ].join('\n');
  const asHex = (s) => bytesToHex(utf8ToBytes(s));
  check('the duress PIN opened the decoy profile in this run', w.opened.kind === 'opened' && w.opened.slot === 'duress');
  check('neither PIN appears in any stored key or value or in anything logged (as text or as UTF-8 hex)',
    ![PIN_A, PIN_B, asHex(PIN_A), asHex(PIN_B)].some((p) => everything.includes(p)));
  check('the active profile is not written anywhere (no stored key or value names it)',
    !/"keyPrefix"|"id":"second"|"id":"primary"|activeProfile/.test(everything));
  const sources = ['wallet/store-keys.ts', 'wallet/pin.ts', 'wallet/duress.ts', 'wallet/WalletContext.tsx', 'components/LockGate.tsx'].map(read);
  check('source: no store write is ever given the active profile or the session slot',
    sources.every((s) => !/(writeStoreItem|writeSecureItem|setItem|setItemAsync)\([^)]*(activeStoreProfile|activeProfile|pinSessionSlot|sessionSlot)/.test(s)));
  check('source: pin.ts, duress.ts and LockGate.tsx log nothing', ['wallet/pin.ts', 'wallet/duress.ts', 'components/LockGate.tsx'].every((f) => !/console\.\w+\(/.test(read(f))));
  const pad = read('components/LockGate.tsx');
  check('source: the PinPad clears the typed digits BEFORE the check runs, and blocks screen capture with its own key',
    pad.indexOf("setDigits('');") > 0 && pad.indexOf("setDigits('');") < pad.indexOf('onComplete(next)') && pad.includes("usePreventScreenCapture('pin-pad');"));
}

// ---------------------------------------------------------------------------
console.log('check-duress: notifications are refused while an app PIN exists (section 7.4)');
// ---------------------------------------------------------------------------
function prefsRule(dm) {
  return {
    on: dm.effectivePrefs({ autoLockMs: null, screenProtection: false, notifications: true }, true),
    off: dm.effectivePrefs({ autoLockMs: null, screenProtection: false, notifications: true }, false),
  };
}
{
  const r = prefsRule(duressMod);
  check('with an app PIN: notifications off, screen protection on, auto-lock never off (1 minute when stored "off")',
    r.on.notifications === false && r.on.screenProtection === true && r.on.autoLockMs === 60_000);
  check('…without one, the stored choices exactly', r.off.notifications === true && r.off.screenProtection === false && r.off.autoLockMs === null);
  check('the one sentence, exactly',
    duressMod.NOTIFICATIONS_OFF_WITH_PIN === 'Notifications are off while the app PIN is on: a notification can be read on the lock screen without your PIN.');
  const prefsCtx = read('wallet/PrefsContext.tsx');
  check('PrefsContext: notifications are the forced value, and turning them on is refused with that sentence while a PIN exists',
    prefsCtx.includes('notifications: forced.notifications,') &&
      prefsCtx.includes('setNotifications: (on) => (appPinOn && on ? Promise.reject(new Error(NOTIFICATIONS_OFF_WITH_PIN)) : patch({ notifications: on })),'));
  const settings = read('screens/SettingsScreen.tsx');
  check('Settings: with an app PIN the Notifications section shows only that sentence (no switch); without one, the usual section',
    /\{appPinOn \? \(\s*<View style=\{styles\.section\}>\s*<Text accessibilityRole="header"[^>]*>\{NOTIFICATIONS_SECTION_TITLE\}<\/Text>\s*<Text[^>]*>\{NOTIFICATIONS_OFF_WITH_PIN\}<\/Text>\s*<\/View>\s*\) : \(\s*<NotificationSettingsSection \/>/.test(settings));
  check('Settings: turning the PIN on first switches notifications off and clears what was scheduled or shown',
    /await setNotifications\(false\)[\s\S]{0,120}await appNotifications\(\)\.disable\(\)[\s\S]{0,80}await turnOnAppPin\(next!\)/.test(settings));
  check('Settings: auto-lock "Off" is not offered while the PIN is on', /AUTO_LOCK_CHOICES\.map\(\(choice\) =>\s*\/\/[^\n]*\n\s*appPinOn && choice\.ms === null \? null : \(/.test(settings));
}

// ---------------------------------------------------------------------------
console.log('check-duress: the lock gate in PIN mode (lock.ts, LockGate.tsx)');
// ---------------------------------------------------------------------------
function pinLaunch(lm) {
  const fed = lm.lockGateWalletStatus('loading', true);
  const inputs = { walletStatus: fed, prefsReady: true, autoLockMs: 60_000, available: lm.lockGateAvailable(false, true) };
  const g = lm.reconcileLockGate(lm.INITIAL_LOCK_GATE_STATE, inputs);
  const view = lm.lockGateView(g, inputs);
  const unlocked = lm.applyLockGateEvent(g, { type: 'unlock' }, 60_000);
  const readyInputs = { ...inputs, walletStatus: lm.lockGateWalletStatus('ready', true) };
  return { fed, view, after: lm.lockGateView(lm.reconcileLockGate(unlocked, readyInputs), readyInputs) };
}
{
  const p = pinLaunch(lockMod);
  check('with an app PIN, a wallet loading behind the PIN counts as ready, so the launch shows the lock (with its PinPad), even with no biometrics',
    p.fed === 'ready' && p.view === 'lock', JSON.stringify(p));
  check('…and once the PIN was accepted and the wallet loaded, the screens', p.after === 'screens');
  check('without an app PIN the status and the device answer pass through unchanged',
    lockMod.lockGateWalletStatus('loading', false) === 'loading' && lockMod.lockGateAvailable(false, false) === false && lockMod.lockGateAvailable(null, false) === null);
  const gate = read('components/LockGate.tsx');
  check('LockGate: the lock view shows the PinPad while a PIN is set, and the Unlock button otherwise; the same pad at launch and after auto-lock',
    /\{appPinOn \? \(\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*<PinPad key=\{awaitingPin \? 'launch' : 'return'\} prompt=\{PIN_PAD_TITLE\} onComplete=\{unlockWithAppPin\} \/>/.test(gate) &&
      gate.includes('const status = lockGateWalletStatus(walletStatus, appPinOn);') && gate.includes('const available = lockGateAvailable(deviceAvailable, appPinOn);'));
  check('LockGate: the tree below is remounted when a PIN opened the other wallet (keyed on profileKey)', gate.includes('<View key={`profile-${profileKey}`} style={styles.fill}>'));
  const ctx = read('wallet/WalletContext.tsx');
  const launchAt = ctx.indexOf('pinOn = (await readPinRecord(appSecureBackend())) !== null;');
  check('WalletContext: at launch the PIN record is read BEFORE the phrase location, and nothing loads while a PIN is set',
    launchAt > 0 && launchAt < ctx.indexOf('const location = await phraseLocation();') && /if \(pinOn\) \{\s*awaitingPinRef\.current = true;\s*setAwaitingPin\(true\);\s*return;\s*\}/.test(ctx));
  const unlock = ctx.slice(ctx.indexOf('const unlockWithPin = useCallback('), ctx.indexOf('const checkSessionPin = useCallback('));
  check('WalletContext.unlockWithPin: drops a held phrase and sets the PIN\'s profile BEFORE reloading',
    unlock.indexOf('dropPhraseTicket();') < unlock.indexOf('setActiveStoreProfile(profile);') && unlock.indexOf('setActiveStoreProfile(profile);') < unlock.indexOf('await reloadWallet();') &&
      unlock.includes('const profile = profileForSlot(outcome.slot);'));
  check('WalletContext: only the real wallet can add a duress PIN or remove the PIN; under the second wallet the sentence is neutral',
    (ctx.match(/if \(slot !== 'primary'\) throw new Error\(PIN_ACTION_NOT_COMPLETED\);/g) ?? []).length === 4 &&
      duressMod.PIN_ACTION_NOT_COMPLETED === 'This could not be completed on this phone. Nothing was changed.');
}

// ---------------------------------------------------------------------------
console.log('check-duress: the honest claim on the duress screens (section 4.3)');
// ---------------------------------------------------------------------------
{
  const claim = duressMod.DURESS_HONEST_CLAIM;
  const three = (t) =>
    t.includes('someone looking at the screen sees an ordinary wallet.') &&
    t.includes("Anyone who copies this app's files from the phone can tell that two wallets exist") &&
    /Funding the second wallet from (this|the real) wallet links them on-chain\.$/.test(t) &&
    t.split(/(?<=\.)\s+/).length === 3;
  check('the claim says: an ordinary wallet to someone at the screen; two wallets visible to a file copier; funding links them on-chain (three sentences)',
    three(claim), claim);
  check('…and never "undetectable", "hidden" or "invisible" in any duress or PIN sentence',
    Object.entries(duressMod).filter(([, v]) => typeof v === 'string').every(([, v]) => !/undetectable|hidden|invisible/i.test(v)));
  check('the readiness reason (row duress-pin) is the same claim in at most three sentences', three(duressMod.DURESS_READINESS_REASON), duressMod.DURESS_READINESS_REASON);
  const settings = read('screens/SettingsScreen.tsx');
  check('Settings renders the claim in the duress section, with the funding and the backup notes',
    settings.includes('<WarningBox>{DURESS_HONEST_CLAIM}</WarningBox>') && settings.includes('{DURESS_FUNDING_NOTE}') && settings.includes('{DURESS_BACKUP_NOTE}'));
  check('the backup check: two distinct positions, uniformly chosen, and the typed words compared case-insensitively',
    (() => {
      const pos = duressMod.backupCheckPositions(12, detRandom);
      return pos[0] !== pos[1] && pos.every((p) => p >= 0 && p < 12) &&
        duressMod.backupWordsMatch(PARENT_12, [0, 11], ['Abandon ', 'ABOUT']) && !duressMod.backupWordsMatch(PARENT_12, [0, 11], ['abandon', 'abandon']) &&
        duressMod.backupCheckLabel([2, 8]) === 'word 3 and word 9';
    })());
}

// ---------------------------------------------------------------------------
console.log('check-duress: mutants (each must be caught)');
// ---------------------------------------------------------------------------
const MUTANT_DIR = join(HERE, `.mutants-duress-${process.pid}`);
mkdirSync(MUTANT_DIR, { recursive: true });
let mutantNo = 0;
/** Imports a copy of src/wallet/<file> with one replacement; relative imports point at the real modules. */
async function mutant(file, from, to) {
  const src = read(`wallet/${file}`);
  if (!src.includes(from)) throw new Error(`mutant anchor missing in ${file}: ${from}`);
  const realDir = pathToFileURL(join(SRC, 'wallet')).href;
  const text = src.replace(from, to).replace(/from '\.\/([^']+)'/g, (_, p) => `from '${realDir}/${p}'`);
  mutantNo += 1;
  const out = join(MUTANT_DIR, `m${mutantNo}-${file}`);
  writeFileSync(out, text);
  return import(pathToFileURL(out).href);
}
try {
  {
    const m = await mutant('pin.ts', 'const h1 = await dd.kdf(pin, record.slots[1].subarray(0, PIN_SALT_BYTES));',
      'const h1 = equalBytesConstantTime(h0, record.slots[0].subarray(PIN_SALT_BYTES)) ? new Uint8Array(32) : await dd.kdf(pin, record.slots[1].subarray(0, PIN_SALT_BYTES));');
    const c = await hashCounts(m);
    check('mutant caught: the duress hash skipped when the primary matched (unequal work)', c.primary.calls !== 2);
  }
  {
    const m = await mutant('pin.ts', 'const m = await matchSlots(record, pin, dd);\n  const slot', 'const m = { primary: false, duress: false };\n  const slot');
    // (The counter write before the hashes is the next mutant.)
    const c = await hashCounts(m);
    check('mutant caught: an attempt that computes no hash at all', c.primary.calls !== 2 || c.primary.kind !== 'opened');
  }
  {
    const m = await mutant('pin.ts', "  await writePinRecord(backend, { ...record, fails, until });\n  // A malformed", '  // A malformed');
    check('mutant caught: the counter written only after the hashes (an attempt killed mid-hash would not count)', (await preIncrement(m)) !== 1);
  }
  {
    const m = await mutant('pin.ts', 'if (fails < PIN_FREE_ATTEMPTS) return 0;', 'if (fails < PIN_FREE_ATTEMPTS - 1) return 0;');
    check('mutant caught: the first wait after 4 wrong PINs instead of 5', JSON.stringify((await schedule(m)).seen) !== JSON.stringify(EXPECTED_SCHEDULE));
  }
  {
    const m = await mutant('pin.ts', 'return { v: 1, slots: [await slotFor(pin, dd), randomSlot(dd)], fails: 0, until: 0 };',
      'return { v: 1, slots: [await slotFor(pin, dd), new Uint8Array(64)], fails: 0, until: 0 };');
    const before = (await recordShape(m));
    // An all-zero unset slot gives a duress PIN away to anyone who reads the record.
    const raw = m.encodePinRecord(await m.createPinRecord(PIN_A, { kdf: countingKdf().kdf, random: detRandom }));
    check('mutant caught: an unset duress slot that is not random (all zeros) — its content would reveal "no duress PIN"',
      JSON.parse(raw).slots[1] === '0'.repeat(128) && before.lengthOnly === 358 &&
        !(JSON.parse(pinMod.encodePinRecord(await pinMod.createPinRecord(PIN_A, { kdf: countingKdf().kdf, random: detRandom }))).slots[1] === '0'.repeat(128)));
  }
  {
    const m = await mutant('pin.ts', "fails: fails.toString(16).padStart(FAILS_HEX, '0'),", 'fails: fails.toString(16),');
    let caught = false;
    try { caught = (await recordShape(m)).lengthOnly !== 358; } catch { caught = true; }
    check('mutant caught: a record whose length depends on its content (unpadded counter)', caught);
  }
  {
    const m = await mutant('pin.ts', 'if (slot !== null && (expect === undefined || slot === expect)) {', 'if (slot !== null) {');
    const e = await expectSlot(m);
    check('mutant caught: the other wallet\'s PIN accepted as "current PIN" (and resetting the counter)', e.other !== 'wrong' || e.failsAfterOther !== 2);
  }
  {
    const m = await mutant('duress.ts', "return slot === 'primary' ? PRIMARY_STORE_PROFILE : DECOY_STORE_PROFILE;", 'return PRIMARY_STORE_PROFILE;');
    const iso = await decoyIsolation(m).catch(() => ({ phrase: null, touched: [] }));
    check('mutant caught: the duress PIN opening the real wallet (its phrase shown, its secrets read)',
      iso.phrase !== independentChild(PARENT_12, 12) || !iso.touched.every((k) => k.startsWith('shiba-wallet.profile-w2.')));
  }
  {
    const m = await mutant('duress.ts', 'return bip85ChildMnemonic(realPhrase, DECOY_BIP85_INDEX, words);', 'return bip85ChildMnemonic(realPhrase, 1, words);');
    check('mutant caught: the decoy at another BIP-85 index', sha256Hex((await decoyPhrases(m)).c12) !== CHILD_12_SHA256);
  }
  {
    const m = await mutant('duress.ts', 'for (const profile of [DECOY_STORE_PROFILE, PRIMARY_STORE_PROFILE]) {', 'for (const profile of [PRIMARY_STORE_PROFILE]) {');
    const w = await wipeBoth(m);
    check('mutant caught: "Remove wallet" that leaves the second wallet\'s secrets', w.after.secure.length > 0);
  }
  {
    const m = await mutant('duress.ts', "    if (storeKeyScope(parsed.key) === 'device') continue;\n", '');
    const w = await wipeBoth(m);
    check('mutant caught: "Remove wallet" that also deletes the device settings', !w.after.async.includes('shiba-wallet.prefs.v1'));
  }
  {
    const m = await mutant('duress.ts', 'notifications: appPinOn ? false : prefs.notifications,', 'notifications: prefs.notifications,');
    check('mutant caught: reminders left on while an app PIN exists', prefsRule(m).on.notifications !== false);
  }
  {
    const m = await mutant('store-keys.ts', "if (profile.keyPrefix === null || scope === 'device') return key;", 'if (profile.keyPrefix === null) return key;');
    const { device } = profileKeys(m);
    check('mutant caught: the profile prefix applied to device keys', !device.every((r) => r.scoped === r.k));
  }
  {
    const m = await mutant('lock.ts', "return appPinOn && walletStatus === 'loading' ? 'ready' : walletStatus;", 'return walletStatus;');
    check('mutant caught: a PIN launch that would not show the lock (status passed through)', pinLaunch(m).view !== 'lock');
  }
} finally {
  rmSync(MUTANT_DIR, { recursive: true, force: true });
  seam.setActiveStoreProfile(seam.PRIMARY_STORE_PROFILE);
}

console.log(`\ncheck-duress: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

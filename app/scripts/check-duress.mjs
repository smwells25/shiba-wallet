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
//  - the wait measured from the END of a failed attempt (pass p21f: the
//    hashes took ~4 minutes, longer than the first waits), refused at once
//    with no hash while it runs, counted down by the lock screen's pad;
//  - the Developer-mode PIN hashing cost measurement (src/wallet/pin-cost.ts):
//    the PIN's own scrypt function and parameters, the sizes, the
//    120-second ceiling, nothing stored, test networks only, its wording;
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
import { scrypt as nodeScryptCb, scryptSync } from 'node:crypto';
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
import * as pinCost from '../src/wallet/pin-cost.ts';
import * as nativeMod from '../src/wallet/pin-native-scrypt.ts';
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
  // 371 = version 1's 358 + the 13 characters of `,"kind":"pin"` (version 2,
  // docs/DURESS_WALLET.md section 8.2.5); the passphrase kind is pinned below.
  check('the record has the same byte length with and without a duress PIN: 371 bytes (version 2), pinned',
    shape.lengthOnly === 371 && shape.lengthBoth === 371 && pinMod.PIN_RECORD_LENGTH === 371 && pinMod.PIN_RECORD_LENGTH_V1 === 358, JSON.stringify(shape));
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
  // Phase 22 follow-up: WalletContext narrows the outcome to "not opened" and
  // uses pinRefusalMessage, which always has a sentence in the lock's own
  // word, instead of an English 'Wrong PIN. Try again.' fallback literal.
  const refusals = [
    { kind: 'wrong', fails: 1, until: 0 }, { kind: 'wrong', fails: 5, until: 30_000 }, { kind: 'wait', until: 3_600_000 }, { kind: 'wait', until: -1 },
    { kind: 'wrong', fails: 1, until: 0, lock: 'phr' }, { kind: 'wait', until: 29_000, lock: 'phr' }, { kind: 'no-pin' },
  ];
  check('pinRefusalMessage gives the same sentence as pinAttemptMessage for every outcome that did not open a wallet (PIN and passphrase), and pinAttemptMessage is null only for "opened"',
    refusals.every((o) => typeof pinMod.pinRefusalMessage(o, 0) === 'string' && pinMod.pinRefusalMessage(o, 0) === pinMod.pinAttemptMessage(o, 0)) &&
      pinMod.pinRefusalMessage({ kind: 'wrong', fails: 1, until: 0, lock: 'phr' }, 0) === 'Wrong passphrase. Try again.' &&
      pinMod.pinAttemptMessage({ kind: 'opened', slot: 'primary' }, 0) === null);
  const ctxSrc = read('wallet/WalletContext.tsx');
  const noFallback = (src) => !src.includes("'Wrong PIN. Try again.'") && (src.match(/pinRefusalMessage\(outcome, Date\.now\(\)\)/g) ?? []).length === 2;
  check('WalletContext holds no "Wrong PIN. Try again." fallback literal; both attempt paths use pinRefusalMessage (source)', noFallback(ctxSrc));
  check('…mutant caught: the old fallback literal back in WalletContext',
    !noFallback(ctxSrc.replace('const message = pinRefusalMessage(outcome, Date.now());', "const message = pinAttemptMessage(outcome, Date.now()) ?? 'Wrong PIN. Try again.';")));
}

/**
 * Pass p21f: each hash takes longer than the first wait (a fake clock moved
 * by the KDF itself, 125 s per hash, 250 s per attempt — the emulator's
 * debug build measured 245–258 s). Every stored value's length is recorded.
 */
async function slowAttempts(pin) {
  const backend = fakeSecureStore();
  const lengths = [];
  const set = backend.setItemAsync;
  backend.setItemAsync = async (k, v, o) => {
    lengths.push(v.length);
    return set(k, v, o);
  };
  let now = 1_000_000;
  let hashes = 0;
  const kdf = async (p, salt) => {
    hashes += 1;
    now += 125_000;
    return sha256(concatBytes(salt, utf8ToBytes(p)));
  };
  const deps = { kdf, random: detRandom, now: () => now };
  await pin.writePinRecord(backend, await pin.createPinRecord(PIN_A, { ...deps, kdf: countingKdf().kdf }));
  const outs = [];
  for (let i = 1; i <= 5; i += 1) {
    const started = now;
    const out = await pin.attemptPin(backend, '000001', deps);
    outs.push({ out, started, ended: now });
  }
  const fifth = outs[4];
  const visible = pin.pinAttemptMessage(fifth.out, fifth.ended);
  // One second later, a sixth PIN (even the right one) is refused at once.
  now = fifth.ended + 1_000;
  const rawBefore = [...backend.items.values()][0];
  hashes = 0;
  const during = await pin.attemptPin(backend, PIN_A, deps);
  const duringHashes = hashes;
  const duringText = pin.pinAttemptMessage(during, now);
  const unchanged = [...backend.items.values()][0] === rawBefore;
  const countdown = pin.pinCountdownOf(fifth.out);
  const at10 = countdown ? pin.pinCountdownText(countdown, fifth.ended + 10_000) : null;
  const atEnd = countdown ? pin.pinCountdownText(countdown, fifth.out.until) : null;
  const duringCountdown = pin.pinCountdownOf(during);
  const waitOver = duringCountdown ? pin.pinCountdownText(duringCountdown, during.until) : null;
  // After the wait: one more wrong PIN → 60 s from ITS end, then 120 s.
  now = fifth.out.until;
  const sixth = await pin.attemptPin(backend, '000001', deps);
  const sixthWait = sixth.until - now;
  now = sixth.until;
  const seventh = await pin.attemptPin(backend, '000001', deps);
  const seventhWait = seventh.until - now;
  now = seventh.until;
  const ok = await pin.attemptPin(backend, PIN_A, deps);
  const after = await pin.readPinRecord(backend);
  return {
    kinds: outs.map((o) => o.out.kind).join(','),
    firstFourUntil: outs.slice(0, 4).map((o) => o.out.until),
    fifthWaitFromEnd: fifth.out.until - fifth.ended,
    fifthAheadAtAnswer: fifth.out.until > fifth.ended,
    visible,
    during: during.kind,
    duringHashes,
    duringText,
    unchanged,
    at10,
    atEnd,
    waitOver,
    sixthWait,
    seventhWait,
    ok: ok.kind,
    resetFails: after.fails,
    resetUntil: after.until,
    lengths,
  };
}
{
  check('the wait schedule as a pure function, by table: wrong PINs in a row → seconds (5 free, 30 s doubling, 1-hour cap)',
    JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 400].map(pinMod.pinWaitSeconds)) ===
      JSON.stringify([0, 0, 0, 0, 0, 30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600, 3600]) &&
      [0, 5, 6, 12, 400].every((n) => pinMod.waitAfterFailures(n) === pinMod.pinWaitSeconds(n) * 1000));
  const slow = await slowAttempts(pinMod);
  check('pass p21f: five wrong PINs whose hashes take 250 s each — the first four start no wait, the fifth a visible 30-second wait from the END of that attempt',
    slow.kinds === 'wrong,wrong,wrong,wrong,wrong' && slow.firstFourUntil.every((u) => u === 0) &&
      slow.fifthWaitFromEnd === 30_000 && slow.fifthAheadAtAnswer, JSON.stringify(slow));
  check('…so the answer shown is "Wrong PIN. Try again in 30 seconds." (the old start-stamped wait had run out 220 s before)',
    slow.visible === 'Wrong PIN. Try again in 30 seconds.', slow.visible);
  check('a PIN typed during the wait (even the right one) is refused at once: zero hashes, the record unchanged, "Too many wrong PINs. Try again in 29 seconds."',
    slow.during === 'wait' && slow.duringHashes === 0 && slow.unchanged && slow.duringText === 'Too many wrong PINs. Try again in 29 seconds.', JSON.stringify(slow));
  check('the pad\'s countdown from the stamped time: 20 seconds left at +10 s, then "Wrong PIN. Try again." / the wait-over sentence at the end',
    slow.at10 === 'Wrong PIN. Try again in 20 seconds.' && slow.atEnd === 'Wrong PIN. Try again.' &&
      slow.waitOver === 'You can enter your PIN again.' && pinMod.PIN_WAIT_OVER_MESSAGE === slow.waitOver, JSON.stringify([slow.at10, slow.atEnd, slow.waitOver]));
  check('the doubling, each from the end of its own slow attempt: 60 s after the sixth, 120 s after the seventh',
    slow.sixthWait === 60_000 && slow.seventhWait === 120_000, JSON.stringify([slow.sixthWait, slow.seventhWait]));
  check('a correct PIN after the wait opens and resets the counter and the wait', slow.ok === 'opened' && slow.resetFails === 0 && slow.resetUntil === 0);
  check(`every value written in that run is exactly 371 bytes, version 2 (${slow.lengths.length} writes: before, during and after the waits)`,
    slow.lengths.length >= 10 && slow.lengths.every((l) => l === 371), JSON.stringify(slow.lengths));
  check('pinCountdownOf: a wrong PIN that starts a wait and a refusal during one start a countdown; a plain wrong PIN or an opened one none',
    JSON.stringify(pinMod.pinCountdownOf({ kind: 'wrong', fails: 5, until: 9 })) === '{"kind":"wrong","until":9}' &&
      JSON.stringify(pinMod.pinCountdownOf({ kind: 'wait', until: 9 })) === '{"kind":"wait","until":9}' &&
      pinMod.pinCountdownOf({ kind: 'wrong', fails: 1, until: 0 }) === null && pinMod.pinCountdownOf({ kind: 'opened', slot: 'primary' }) === null);
  const ctx = read('wallet/WalletContext.tsx');
  check('WalletContext.unlockWithPin returns the stamped wait with the sentence (pinCountdownOf)',
    /const countdown = pinCountdownOf\(outcome\);\s*return countdown \? \{ ok: false, message, countdown \} : \{ ok: false, message \};/.test(ctx));
  const gate = read('components/LockGate.tsx');
  check('LockGate: the lock screen hands the wait to the PinPad, which counts it down once a second from the stamped time',
    gate.includes('if (!outcome.ok) return outcome.countdown ? { countdown: outcome.countdown } : outcome.message;') &&
      gate.includes('const line = countdown ? pinCountdownText(countdown, clock) : message;') &&
      /setInterval\(\(\) => \{\s*const t = Date\.now\(\);\s*setClock\(t\);\s*if \(t >= countdown\.until\) clearInterval\(timer\);\s*\}, PIN_COUNTDOWN_TICK_MS\);/.test(gate) &&
      // Phase 23 item 8: the line goes through the string table (a refusal
      // that is a table entry is shown in the chosen language).
      gate.includes('export const PIN_COUNTDOWN_TICK_MS = 1000;') && gate.includes("{line === null ? '' : localize(line)}"));
  check('LockGate: a screen reader hears the wait when it starts and when it ends, not every second (live region off while it ticks)',
    gate.includes("const ticking = countdown !== null && clock !== countdownFrom && clock < countdown.until;") &&
      gate.includes("accessibilityLiveRegion={ticking ? 'none' : 'polite'}"));
}

// ---------------------------------------------------------------------------
console.log('check-duress: the PIN hashing cost measurement (src/wallet/pin-cost.ts, Settings → Developer)');
// ---------------------------------------------------------------------------
/** The PIN check and the measurement share pinScrypt and the PIN's parameters (source). */
function sameScryptPin(pinSrc, costSrc) {
  return /function defaultKdf\(pin: string, salt: Uint8Array\): Promise<Uint8Array> \{\s*return pinScrypt\(pin, salt\);\s*\}/.test(pinSrc) &&
    pinSrc.includes('const opts = { N: 2 ** log2N, r: PIN_SCRYPT.r, p: PIN_SCRYPT.p, dkLen: PIN_SCRYPT.dkLen };') &&
    pinSrc.includes('export const PIN_SCRYPT = Object.freeze({ N: 2 ** PIN_SCRYPT_LOG2_N, r: 8, p: 1, dkLen: 32 });') &&
    costSrc.includes("import { PIN_SALT_BYTES, PIN_SCRYPT_LOG2_N, pinScrypt } from './pin.ts';") && costSrc.includes('const hash = deps.hash ?? pinScrypt;') &&
    costSrc.includes('const salt = random(PIN_SALT_BYTES);') && costSrc.includes('const out = await hash(PIN_COST_INPUT, salt, log2N, () => {');
}
/** A fake hash on a fake clock: each size "costs" costs[log2N] ms, reported through onProgress in 10 steps. */
function fakeCostRun(pc, costs, { cancelAt = null } = {}) {
  let now = 0;
  let cancel = false;
  const calls = [];
  const hash = async (input, salt, log2N, onProgress) => {
    calls.push({ input, saltLength: salt.length, log2N, progress: typeof onProgress === 'function' });
    for (let i = 1; i <= 10; i += 1) {
      now += costs[log2N] / 10;
      if (cancelAt !== null && log2N === cancelAt && i === 3) cancel = true;
      onProgress(i / 10);
    }
    return new Uint8Array(32);
  };
  const updates = [];
  return pc
    .measurePinHashCost({ os: 'android', hermes: true, dev: false }, {
      now: () => now,
      random: detRandom,
      hash,
      isCancelled: () => cancel,
      onUpdate: (rows, current) => updates.push(current),
    })
    .then((report) => ({ report, calls, updates }));
}
{
  check('sizes N = 2^12 … 2^16 in order, a 120-second ceiling per size, and the PIN\'s N is the last size',
    JSON.stringify(pinCost.PIN_COST_LOG2_SIZES) === '[12,13,14,15,16]' && pinCost.PIN_COST_CEILING_MS === 120_000 &&
      pinCost.PIN_COST_LOG2_SIZES.at(-1) === pinMod.PIN_SCRYPT_LOG2_N && pinMod.PIN_SCRYPT_LOG2_N === 16 && pinMod.PIN_SCRYPT.N === 2 ** pinMod.PIN_SCRYPT_LOG2_N);
  check('the throwaway input is refused as a PIN by the PIN rules, so it can never be anyone\'s PIN',
    pinCost.PIN_COST_INPUT === '000000' && pinMod.isTriviallyGuessed(pinCost.PIN_COST_INPUT));
  const pinSrc = read('wallet/pin.ts');
  const costSrc = read('wallet/pin-cost.ts');
  check('source: the PIN check and the measurement use the SAME function (pinScrypt) with the PIN\'s r, p and length',
    sameScryptPin(pinSrc, costSrc));
  const salt = detRandom(32);
  check('pinScrypt at N = 2^12 equals scrypt(N = 4096, r = 8, p = 1, dkLen = 32) computed here independently',
    bytesToHex(await pinMod.pinScrypt('000000', salt, 12)) === bytesToHex(scrypt('000000', salt, { N: 4096, r: 8, p: 1, dkLen: 32 })));
  check('…and with a progress callback the result is the same (the callback only lets the run be stopped)',
    bytesToHex(await pinMod.pinScrypt('000000', salt, 12, () => {})) === bytesToHex(scrypt('000000', salt, { N: 4096, r: 8, p: 1, dkLen: 32 })));
  check('source: the measurement stores nothing and sends nothing (no store, secure store, network or log)',
    !/store-keys|AsyncStorage|SecureStore|expo-secure-store|readPinRecord|writePinRecord|attemptPin|fetch\(|XMLHttpRequest|console\.\w+\(/.test(costSrc) &&
      !/AsyncStorage|SecureStore|store-keys|fetch\(|console\.\w+\(/.test(read('components/PinCostMeasurement.tsx')));

  const real = await pinCost.measurePinHashCost({ os: 'node', hermes: false, dev: true });
  check(`the real run under Node: every size measured with the real hash (${real.rows.map((r) => `2^${r.log2N} ${Math.round(r.ms)} ms`).join(', ')})`,
    real.finished && real.rows.length === 5 && real.rows.every((r, i) => r.status === 'measured' && r.log2N === 12 + i && r.ms > 0) && real.totalMs >= real.rows.reduce((a, r) => a + r.ms, 0) - 1);
  console.log(`       ${real.rows.map(pinCost.pinCostRowText).join(' | ')}`);

  const fast = await fakeCostRun(pinCost, { 12: 50, 13: 100, 14: 200, 15: 400, 16: 800 });
  check('each size gets the throwaway input, a fresh 32-byte salt and a progress callback; updates before each size and at the end',
    fast.calls.map((c) => c.log2N).join(',') === '12,13,14,15,16' && fast.calls.every((c) => c.input === '000000' && c.saltLength === 32 && c.progress) &&
      JSON.stringify(fast.updates) === '[12,13,14,15,16,null]');
  check('the result lines, exactly', JSON.stringify(fast.report.rows.map(pinCost.pinCostRowText)) ===
    JSON.stringify(['N = 2^12: 50 ms', 'N = 2^13: 100 ms', 'N = 2^14: 200 ms', 'N = 2^15: 400 ms', 'N = 2^16: 800 ms']) &&
    pinCost.pinCostTotalText(fast.report.totalMs) === 'Total time: 1,550 ms (wall clock).' &&
    pinCost.pinCostPlatformText(fast.report.platform) === 'Platform: android · Hermes: yes · development bundle (__DEV__): no',
    JSON.stringify(fast.report));
  const ceil = await fakeCostRun(pinCost, { 12: 1_000, 13: 60_000, 14: 300_000, 15: 1, 16: 1 });
  check('a size past 120 s is stopped at the ceiling and the larger sizes are skipped with a note',
    JSON.stringify(ceil.report.rows.map((r) => r.status)) === '["measured","measured","ceiling","skipped","skipped"]' && !ceil.report.finished &&
      ceil.calls.length === 3 &&
      pinCost.pinCostRowText(ceil.report.rows[2]) === 'N = 2^14: stopped after 150,000 ms, at the 120-second limit for one size (it takes longer than that).' &&
      pinCost.pinCostRowText(ceil.report.rows[3]) === 'N = 2^15: skipped (a smaller size reached the 120-second limit).',
    JSON.stringify(ceil.report.rows.map(pinCost.pinCostRowText)));
  const stopped = await fakeCostRun(pinCost, { 12: 10, 13: 10_000, 14: 1, 15: 1, 16: 1 }, { cancelAt: 13 });
  check('Stop ends the run inside the current hash; the rest are not measured',
    JSON.stringify(stopped.report.rows.map(pinCost.pinCostRowText)) ===
      JSON.stringify(['N = 2^12: 10 ms', 'N = 2^13: stopped by you after 3,000 ms (not finished).', 'N = 2^14: not measured (stopped by you).',
        'N = 2^15: not measured (stopped by you).', 'N = 2^16: not measured (stopped by you).']) && stopped.calls.length === 2,
    JSON.stringify(stopped.report.rows.map(pinCost.pinCostRowText)));
  check('the platform facts: the Hermes marker global.HermesInternal present or not, Platform.OS and __DEV__ as given',
    pinCost.pinCostPlatform('android', { HermesInternal: {} }, false).hermes === true && pinCost.pinCostPlatform('ios', {}, true).hermes === false &&
      pinCost.pinCostPlatform('ios', { HermesInternal: null }, true).hermes === false && pinCost.pinCostPlatform('ios', {}, true).dev === true);
  check('test networks only (readiness isTestNetwork): offered on Ethereum Sepolia and Hoodi, never on Ethereum mainnet',
    pinCost.pinCostMeasurementOffered('eip155:11155111') && pinCost.pinCostMeasurementOffered('eip155:560048') && !pinCost.pinCostMeasurementOffered('eip155:1'));
  const settings = read('screens/SettingsScreen.tsx');
  check('Settings → Developer renders it only where offered, after the minimum-fee rehearsal',
    settings.includes('{pinCostMeasurementOffered(evmChain.caip2) ? <PinCostMeasurement /> : null}') &&
      settings.indexOf('{MINIMUM_FEE_REHEARSAL_HINT}') < settings.indexOf('<PinCostMeasurement />') &&
      settings.indexOf('<PinCostMeasurement />') < settings.indexOf('<CustomNetworksSection'));
  check('the button and note wording, exactly',
    pinCost.PIN_COST_BUTTON === 'Measure the PIN hashing cost' && pinCost.PIN_COST_STOP_BUTTON === 'Stop the measurement' &&
      pinCost.PIN_COST_HINT === 'Test networks only. Times the scrypt hash the app PIN uses, on this phone: one hash at each size from N = 2^12 to N = 2^16, ' +
        "so the PIN's cost setting can be chosen from a real figure (the PIN uses N = 2^16 today, and unlocking computes two hashes at that size). " +
        'It uses a random salt and a throwaway input, never your PIN or its record; nothing is stored and nothing leaves this phone. ' +
        'A size that runs longer than 120 seconds is stopped and the larger sizes are skipped.' &&
      pinCost.PIN_COST_RESULT_NOTE === "Each figure is one hash. Unlocking with the app PIN computes two hashes at the PIN's size. Nothing was stored." &&
      pinCost.pinCostRunningText(14) === 'Measuring N = 2^14…' &&
      pinCost.pinCostFailedText('x') === 'The measurement could not be run. Nothing was stored. Technical detail: x');
  const view = read('components/PinCostMeasurement.tsx');
  check('the component: the platform from Platform.OS, the global object and __DEV__; Stop and leaving the screen cancel the run',
    view.includes('const platform = pinCostPlatform(Platform.OS, globalThis, __DEV__);') && view.includes('isCancelled: () => cancel.current,') &&
      /return \(\) => \{\s*mounted\.current = false;\s*cancel\.current = true;\s*\};/.test(view) &&
      view.includes('<Button title={PIN_COST_STOP_BUTTON} variant="secondary" onPress={() => (cancel.current = true)} />') &&
      view.includes('<Button title={PIN_COST_BUTTON} variant="secondary" onPress={start} />'));
}

// ---------------------------------------------------------------------------
console.log('check-duress: the native scrypt path (src/wallet/pin-native-scrypt.ts, react-native-quick-crypto)');
// ---------------------------------------------------------------------------
/** A stand-in for the native scrypt: Node's crypto.scrypt (OpenSSL's EVP_PBE_scrypt, the function react-native-quick-crypto calls). */
function nodeNative({ corrupt = false, failAtN = null } = {}) {
  const calls = [];
  const derive = (input, salt, N, r, p, maxmem, dkLen) => {
    calls.push({ input: Uint8Array.from(input), saltLength: salt.length, N, r, p, maxmem, dkLen });
    if (failAtN !== null && N === failAtN) return Promise.reject(new Error('simulated native failure'));
    return new Promise((resolve, reject) =>
      nodeScryptCb(Buffer.from(input), Buffer.from(salt), dkLen, { N, r, p, maxmem }, (e, k) => {
        if (e) return reject(e);
        const out = new Uint8Array(k);
        if (corrupt) out[0] ^= 1;
        resolve(out);
      }));
  };
  return { calls, loader: async () => ({ kind: 'loaded', derive }) };
}
/** Runs fn with console.warn captured; returns [result, warnings]. */
async function withWarnings(fn) {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.map(String).join(' '));
  try {
    return [await fn(), warned];
  } finally {
    console.warn = orig;
  }
}
const RFC_VECTOR_3_HEX =
  '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887';
{
  const salts = [detRandom(32), detRandom(32), detRandom(32), detRandom(32)];
  const triples = [[PIN_A, salts[0], 12], ['000000', salts[1], 14], ['pïn-ünicode-é', salts[2], 10], [PIN_B, salts[3], 16]];
  check('the oracle: Node\'s crypto.scryptSync equals noble\'s scrypt byte for byte for four (input, salt, N) triples, N = 2^10 … 2^16, r = 8, p = 1, dkLen = 32',
    triples.every(([i, s, n]) => bytesToHex(new Uint8Array(scryptSync(i, s, 32, { N: 2 ** n, r: 8, p: 1, maxmem: nativeMod.pinScryptMaxmem(2 ** n, 8) }))) ===
      bytesToHex(scrypt(i, s, { N: 2 ** n, r: 8, p: 1, dkLen: 32 }))));
  const v = nativeMod.RFC7914_SELF_CHECK;
  check('the self-check vector is RFC 7914 section 12\'s third (P = "pleaseletmein", S = "SodiumChloride", N = 16384, r = 8, p = 1, dkLen = 64), its digest as printed there',
    v.password === 'pleaseletmein' && v.salt === 'SodiumChloride' && v.N === 16384 && v.r === 8 && v.p === 1 && v.dkLen === 64 && v.expectedHex === RFC_VECTOR_3_HEX);
  check('…and Node\'s scrypt and noble\'s scrypt both reproduce that digest',
    bytesToHex(new Uint8Array(scryptSync(v.password, v.salt, 64, { N: v.N, r: v.r, p: v.p }))) === RFC_VECTOR_3_HEX &&
      bytesToHex(scrypt(v.password, v.salt, { N: v.N, r: v.r, p: v.p, dkLen: 64 })) === RFC_VECTOR_3_HEX);
  const nodeAccepts = (maxmem) => {
    try { scryptSync('x', 'y', 32, { N: 65536, r: 8, p: 1, maxmem }); return true; } catch { return false; }
  };
  check('maxmem = 128·r·N + 1 MiB = 68,157,440 bytes at N = 2^16, r = 8; OpenSSL accepts it, and refuses Node\'s 32 MiB default and the bare 128·r·N',
    nativeMod.pinScryptMaxmem(65536, 8) === 68_157_440 && nodeAccepts(68_157_440) && !nodeAccepts(32 * 1024 * 1024) && !nodeAccepts(128 * 8 * 65536) &&
      nodeAccepts(128 * 8 * (65536 + 2) + 128 * 8 * 1));

  // Under Node the app's own loader finds no native module.
  nativeMod.setNativeScryptLoaderForChecks(null);
  const absent = await nativeMod.resolvePinHashPath();
  check('under Node the app\'s loader reports the native module absent: JavaScript scrypt, and the Developer line says so',
    absent.kind === 'javascript' && absent.reason === 'absent' &&
      nativeMod.pinHashPathLine(absent) === 'PIN hashing path: JavaScript scrypt (@noble/hashes): the native module is not in this build');
  check('the Developer line before the path is known, and with the native path',
    nativeMod.pinHashPathLine(null) === 'PIN hashing path: checking…' &&
      nativeMod.pinHashPathLine({ kind: 'native' }) === 'PIN hashing path: native scrypt (react-native-quick-crypto), self-check passed');

  // The native path, with Node's scrypt standing in for the library.
  const nat = nodeNative();
  nativeMod.setNativeScryptLoaderForChecks(nat.loader);
  const native = await nativeMod.resolvePinHashPath();
  check('a native scrypt that passes the RFC 7914 self-check is used: the first call is the self-check vector with maxmem 128·r·N + 1 MiB',
    native.kind === 'native' && nat.calls.length === 1 && nat.calls[0].N === 16384 && nat.calls[0].dkLen === 64 &&
      nat.calls[0].maxmem === 128 * 8 * 16384 + 1_048_576 && new TextDecoder().decode(nat.calls[0].input) === 'pleaseletmein');
  let allEqual = true;
  for (const [i, s, n] of triples) {
    const before = nat.calls.length;
    const viaNative = await pinMod.pinScrypt(i, s, n);
    const c = nat.calls.at(-1);
    allEqual &&= nat.calls.length === before + 1 && c.N === 2 ** n && c.r === 8 && c.p === 1 && c.dkLen === 32 &&
      c.maxmem === nativeMod.pinScryptMaxmem(2 ** n, 8) && bytesToHex(c.input) === bytesToHex(utf8ToBytes(i)) &&
      bytesToHex(viaNative) === bytesToHex(scrypt(i, s, { N: 2 ** n, r: 8, p: 1, dkLen: 32 }));
  }
  check('pinScrypt through the native path equals noble byte for byte for the four triples (incl. N = 2^16 and a non-ASCII input as UTF-8), one native call each',
    allEqual && (await nativeMod.resolvePinHashPath()).kind === 'native');
  let progressCalls = 0;
  await pinMod.pinScrypt('000000', salts[0], 12, () => { progressCalls += 1; });
  check('on the native path the progress callback is never called (the native hash cannot be interrupted)', progressCalls === 0);

  // A PIN set on one path opens on the other, both ways.
  nativeMod.setNativeScryptLoaderForChecks(async () => ({ kind: 'absent' }));
  const jsBackend = fakeSecureStore();
  await pinMod.setAppPin(jsBackend, PIN_A, { random: detRandom });
  nativeMod.setNativeScryptLoaderForChecks(nodeNative().loader);
  const openedNative = await pinMod.attemptPin(jsBackend, PIN_A, { random: detRandom });
  const wrongNative = await pinMod.attemptPin(jsBackend, PIN_B, { random: detRandom });
  const natBackend = fakeSecureStore();
  await pinMod.setAppPin(natBackend, PIN_B, { random: detRandom });
  nativeMod.setNativeScryptLoaderForChecks(async () => ({ kind: 'absent' }));
  const openedJs = await pinMod.attemptPin(natBackend, PIN_B, { random: detRandom });
  check('a PIN set with the JavaScript scrypt opens with the native one (and another PIN is wrong), and a PIN set natively opens with JavaScript',
    openedNative.kind === 'opened' && openedNative.slot === 'primary' && wrongNative.kind === 'wrong' && openedJs.kind === 'opened' && openedJs.slot === 'primary');

  // A native scrypt that fails its self-check is not used.
  const bad = nodeNative({ corrupt: true });
  nativeMod.setNativeScryptLoaderForChecks(bad.loader);
  const [badPath, badWarn] = await withWarnings(() => nativeMod.resolvePinHashPath());
  const badOut = await pinMod.pinScrypt(PIN_A, salts[0], 12);
  check('a native scrypt whose self-check output differs is not used: JavaScript path, the reason kept, the hash still correct, the native module not called again',
    badPath.kind === 'javascript' && badPath.reason === 'self-check-failed' && bad.calls.length === 1 &&
      bytesToHex(badOut) === bytesToHex(scrypt(PIN_A, salts[0], { N: 4096, r: 8, p: 1, dkLen: 32 })) &&
      nativeMod.pinHashPathLine(badPath).startsWith('PIN hashing path: JavaScript scrypt (@noble/hashes): the native module failed its self-check against the RFC 7914 test vector, so it is not used.'));
  check('…and the reason is logged once, naming no PIN, salt or hash',
    badWarn.length === 1 && badWarn[0].includes('self-check-failed') && !badWarn[0].includes(PIN_A) && !/[0-9a-f]{32}/.test(badWarn[0]), JSON.stringify(badWarn));

  // A native hash that fails later in the session.
  const late = nodeNative({ failAtN: 2 ** 16 });
  nativeMod.setNativeScryptLoaderForChecks(late.loader);
  const [lateOut, lateWarn] = await withWarnings(() => pinMod.pinScrypt(PIN_A, salts[3], 16));
  const lateCalls = late.calls.length;
  await pinMod.pinScrypt(PIN_A, salts[0], 12);
  const latePath = await nativeMod.resolvePinHashPath();
  check('a native hash that fails mid-session falls back to JavaScript for that hash (same bytes) and for the rest of the session',
    bytesToHex(lateOut) === bytesToHex(scrypt(PIN_A, salts[3], { N: 65536, r: 8, p: 1, dkLen: 32 })) && lateCalls === 2 && late.calls.length === 2 &&
      latePath.kind === 'javascript' && latePath.reason === 'native-error' && lateWarn.length === 1 &&
      nativeMod.pinHashPathLine(latePath).startsWith('PIN hashing path: JavaScript scrypt (@noble/hashes): the native module failed during a hash and is not used for the rest of this session.'));
  nativeMod.setNativeScryptLoaderForChecks(async () => { throw new Error('boom'); });
  const [failedPath] = await withWarnings(() => nativeMod.resolvePinHashPath());
  check('a native module that cannot be loaded: JavaScript path with the reason',
    failedPath.kind === 'javascript' && failedPath.reason === 'load-failed' &&
      nativeMod.pinHashPathLine(failedPath) === 'PIN hashing path: JavaScript scrypt (@noble/hashes): the native module is in this build but could not be loaded. Technical detail: Error: boom');
  nativeMod.setNativeScryptLoaderForChecks(null);

  // The measurement on the native path.
  const natPath = async () => ({ kind: 'native' });
  let now = 0;
  let cancel = false;
  const nativeHash = (costs, cancelAt = null) => async (input, salt, log2N) => {
    now += costs[log2N];
    if (cancelAt === log2N) cancel = true;
    return new Uint8Array(32);
  };
  const run = (costs, cancelAt = null) => {
    now = 0;
    cancel = false;
    return pinCost.measurePinHashCost({ os: 'android', hermes: true, dev: false },
      { now: () => now, random: detRandom, hash: nativeHash(costs, cancelAt), isCancelled: () => cancel, hashPath: natPath });
  };
  const nFast = await run({ 12: 1, 13: 2, 14: 4, 15: 8, 16: 16 });
  check('the platform line names the path in use: native scrypt (react-native-quick-crypto)',
    nFast.finished && pinCost.pinCostPlatformText(nFast.platform, nFast.hashPath) ===
      'Platform: android · Hermes: yes · development bundle (__DEV__): no · Hashing: native scrypt (react-native-quick-crypto)');
  check('…JavaScript scrypt (@noble/hashes) on the JavaScript path, and both when the native hash failed during the run',
    pinCost.pinCostPlatformText(nFast.platform, { start: { kind: 'javascript', reason: 'absent', detail: null }, end: { kind: 'javascript', reason: 'absent', detail: null } }) ===
      'Platform: android · Hermes: yes · development bundle (__DEV__): no · Hashing: JavaScript scrypt (@noble/hashes)' &&
    pinCost.pinCostPlatformText(nFast.platform, { start: { kind: 'native' }, end: { kind: 'javascript', reason: 'native-error', detail: 'x' } }) ===
      'Platform: android · Hermes: yes · development bundle (__DEV__): no · Hashing: native scrypt (react-native-quick-crypto) at the start, then JavaScript scrypt (@noble/hashes) after the native hash failed during the run');
  const nCeil = await run({ 12: 1, 13: 130_000, 14: 1, 15: 1, 16: 1 });
  check('native path: a size that finished after the 120-second limit stays measured and the larger sizes are skipped',
    JSON.stringify(nCeil.rows.map((r) => r.status)) === '["measured","measured","skipped","skipped","skipped"]' && !nCeil.finished &&
      pinCost.pinCostRowText(nCeil.rows[2]) === 'N = 2^14: skipped (a smaller size reached the 120-second limit).');
  const nStop = await run({ 12: 1, 13: 2, 14: 4, 15: 8, 16: 16 }, 13);
  check('native path: Stop pressed during a size takes effect after it (that size measured, the rest not measured)',
    JSON.stringify(nStop.rows.map(pinCost.pinCostRowText)) === JSON.stringify(['N = 2^12: 1 ms', 'N = 2^13: 2 ms', 'N = 2^14: not measured (stopped by you).',
      'N = 2^15: not measured (stopped by you).', 'N = 2^16: not measured (stopped by you).']));
  check('the hint: unchanged on the JavaScript path, plus the between-sizes sentence on the native path',
    pinCost.pinCostHint(null) === pinCost.PIN_COST_HINT && pinCost.pinCostHint({ kind: 'javascript', reason: 'absent', detail: null }) === pinCost.PIN_COST_HINT &&
      pinCost.pinCostHint({ kind: 'native' }) === `${pinCost.PIN_COST_HINT} This build hashes with native scrypt (react-native-quick-crypto), which cannot be interrupted inside one hash: ` +
        'Stop and the 120-second limit take effect between sizes, and a size already running finishes first.');

  // Source pins.
  const natSrc = read('wallet/pin-native-scrypt.ts');
  const spec = readFileSync(join(HERE, '..', 'node_modules', 'react-native-quick-crypto', 'src', 'specs', 'scrypt.nitro.ts'), 'utf8');
  const onLoad = readFileSync(join(HERE, '..', 'node_modules', 'react-native-quick-crypto', 'nitrogen', 'generated', 'android', 'QuickCryptoOnLoad.cpp'), 'utf8');
  const appPkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  const qcPkg = JSON.parse(readFileSync(join(HERE, '..', 'node_modules', 'react-native-quick-crypto', 'package.json'), 'utf8'));
  check('the hybrid object and method the wallet calls are those of the installed react-native-quick-crypto 1.1.8, pinned exactly in package.json',
    appPkg.dependencies['react-native-quick-crypto'] === '1.1.8' && qcPkg.version === '1.1.8' && nativeMod.NATIVE_SCRYPT_PACKAGE_VERSION === '1.1.8' &&
      nativeMod.NATIVE_SCRYPT_HYBRID_NAME === 'Scrypt' && onLoad.includes('"Scrypt",') &&
      /deriveKey\(\s*password: ArrayBuffer,\s*salt: ArrayBuffer,\s*N: number,\s*r: number,\s*p: number,\s*maxmem: number,\s*keylen: number,\s*\): Promise<ArrayBuffer>;/.test(spec) &&
      natSrc.includes('deriveKey(password: ArrayBuffer, salt: ArrayBuffer, N: number, r: number, p: number, maxmem: number, keylen: number): Promise<ArrayBuffer>;') &&
      natSrc.includes('hybrid.deriveKey(ownBuffer(input), ownBuffer(salt), N, r, p, maxmem, dkLen)'));
  check('source: nothing native is imported at load (type-only import), and Nitro is required only after TurboModuleRegistry.get found it',
    !/^import (?!type )[^;]*from '(react-native|react-native-nitro-modules|react-native-quick-crypto)'/m.test(natSrc) &&
      natSrc.indexOf("rn.TurboModuleRegistry.get('NitroModules') == null") > 0 &&
      natSrc.indexOf("rn.TurboModuleRegistry.get('NitroModules') == null") < natSrc.indexOf("require('react-native-nitro-modules')") &&
      natSrc.indexOf('NitroModules.hasHybridObject(NATIVE_SCRYPT_HYBRID_NAME)') < natSrc.indexOf('NitroModules.createHybridObject'));
  check('source: the one console call in the native module logs a path, never an input (pin.ts still logs nothing)',
    (natSrc.match(/console\.\w+\(/g) ?? []).length === 1 && natSrc.includes('function warnFallback(path: PinHashPath): void {') && !/console\.\w+\(/.test(read('wallet/pin.ts')));
  const viewSrc = read('components/PinCostMeasurement.tsx');
  check('the Developer view shows the path line, the path-aware hint and the platform line with the path',
    viewSrc.includes('{pinHashPathLine(hashPath)}') && viewSrc.includes('{pinCostHint(hashPath)}') &&
      viewSrc.includes('{pinCostPlatformText(report.platform, report.hashPath)}') && viewSrc.includes('resolvePinHashPath().then('));
  // Pass p22a finding 4: TalkBack spelled "(__DEV__)" "2 Underscore DEV 2
  // Underscore"; the platform line keeps its visible text and is spoken in
  // plain words through an accessibilityLabel.
  const spokenOk = (fn) => {
    const plat = { os: 'android', hermes: true, dev: false };
    return fn(plat) === 'Platform: android. Hermes: yes. Development bundle: no.' &&
      fn({ ...plat, dev: true }, { start: { kind: 'native' }, end: { kind: 'native' } }) ===
        'Platform: android. Hermes: yes. Development bundle: yes. Hashing: native scrypt (react-native-quick-crypto).' &&
      !/__|·/.test(fn(plat, { start: { kind: 'native' }, end: { kind: 'javascript', reason: 'native-error', detail: 'x' } }));
  };
  check('p22a finding 4: the platform line is spoken "Platform: android. Hermes: yes. Development bundle: no. Hashing: …" (exact; no "__DEV__", no "·")',
    spokenOk(pinCost.pinCostPlatformSpokenText));
  check('…mutant caught: the visible line spoken as it is (with "(__DEV__)")', !spokenOk(pinCost.pinCostPlatformText));
  const spokenView = (src) => /<Text\s+accessibilityLabel=\{pinCostPlatformSpokenText\(report\.platform, report\.hashPath\)\}\s+style=\{\[styles\.hint, \{ color: theme\.text \}\]\}\s*>\s*\{pinCostPlatformText\(report\.platform, report\.hashPath\)\}\s*<\/Text>/.test(src);
  check('…the Developer view draws the visible line and gives the same Text the spoken label (source)', spokenView(viewSrc));
  check('…mutant caught: the view without the spoken label', !spokenView(viewSrc.replace('accessibilityLabel={pinCostPlatformSpokenText(report.platform, report.hashPath)}', '')));
}

// ---------------------------------------------------------------------------
console.log('check-duress: the storage profiles (store-keys.ts)');
// ---------------------------------------------------------------------------
{
  const { device, other } = profileKeys(seam);
  check(`the decoy profile prefix is applied to every wallet and secret key (${other.length})`,
    other.every((r) => r.scoped === `shiba-wallet.profile-w2.${r.k.slice('shiba-wallet.'.length)}`));
  // Phase 22 item 6 added the device-wide language choice (STORE_KEYS.language): 10 device keys.
  check(`…and to no device key (${device.length})`, device.length === 10 && device.every((r) => r.scoped === r.k));
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
  check('PrefsContext: notifications are the forced value, and turning them on is refused with that sentence (in the lock\'s own word) while a PIN or passphrase exists',
    prefsCtx.includes('notifications: forced.notifications,') &&
      prefsCtx.includes('setNotifications: (on) => (appPinOn && on ? Promise.reject(new Error(notificationsOffWithLock(appLockKind.get()))) : patch({ notifications: on })),'));
  const settings = read('screens/SettingsScreen.tsx');
  check('Settings: with an app lock the Notifications section shows only that sentence, PIN or passphrase by the lock\'s kind (no switch); without one, the usual section',
    /\{appPinOn \? \(\s*<View style=\{styles\.section\}>\s*<Text accessibilityRole="header"[^>]*>(?:<T>)?\{NOTIFICATIONS_SECTION_TITLE\}(?:<\/T>)?<\/Text>\s*<Text[^>]*>(?:<T>)?\{settingsLockKind === 'phr' \? NOTIFICATIONS_OFF_WITH_PASSPHRASE : NOTIFICATIONS_OFF_WITH_PIN\}(?:<\/T>)?<\/Text>\s*<\/View>\s*\) : \(\s*<NotificationSettingsSection \/>/.test(settings));
  // Phase 22 polish: the notes that name the app lock say "passphrase" while
  // the lock is a passphrase; the PIN wording stays byte-identical.
  const PHR = {
    notifications: 'Notifications are off while the app passphrase is on: a notification can be read on the lock screen without your passphrase.',
    screen: 'Screen protection stays on while the app passphrase is on, so the app switcher and screenshots never show the wallet.',
    autoLock: 'While the app passphrase is on, auto-lock cannot be turned off: the wallet asks for the passphrase when it is opened and after this time in the background.',
    // Pass p23-build: no longer "everything" (the dialog names the phone settings and WalletConnect connections it keeps,
    // and the app-lock sweep also removes the smart-account endpoint settings, which the wipe without a lock keeps).
    wipe: 'With the app passphrase on, this also removes every other record the wallet keeps on this phone, including the smart-account bundler, factory and paymaster settings; only the other phone settings and the WalletConnect connections named above are kept. The app passphrase itself is removed too.',
  };
  check('the passphrase forms of the four app-lock notes, exactly (and none says PIN)',
    duressMod.NOTIFICATIONS_OFF_WITH_PASSPHRASE === PHR.notifications && duressMod.SCREEN_PROTECTION_WITH_PASSPHRASE_NOTE === PHR.screen &&
      duressMod.AUTO_LOCK_WITH_PASSPHRASE_NOTE === PHR.autoLock && duressMod.WIPE_WITH_PASSPHRASE_NOTE === PHR.wipe &&
      Object.values(PHR).every((x) => !/\bPIN\b/.test(x)));
  check('…the PIN forms (the wipe note reworded in pass p23-build, the others unchanged), byte for byte',
    duressMod.SCREEN_PROTECTION_WITH_PIN_NOTE === 'Screen protection stays on while the app PIN is on, so the app switcher and screenshots never show the wallet.' &&
      duressMod.AUTO_LOCK_WITH_PIN_NOTE === 'While the app PIN is on, auto-lock cannot be turned off: the wallet asks for the PIN when it is opened and after this time in the background.' &&
      duressMod.WIPE_WITH_PIN_NOTE === 'With the app PIN on, this also removes every other record the wallet keeps on this phone, including the smart-account bundler, factory and paymaster settings; only the other phone settings and the WalletConnect connections named above are kept. The app PIN itself is removed too.');
  check('…picked by kind: notificationsOffWithLock and wipeWithLockNote give the PIN form for "pin", the passphrase form for "phr"',
    duressMod.notificationsOffWithLock('pin') === duressMod.NOTIFICATIONS_OFF_WITH_PIN && duressMod.notificationsOffWithLock('phr') === PHR.notifications &&
      duressMod.wipeWithLockNote('pin') === duressMod.WIPE_WITH_PIN_NOTE && duressMod.wipeWithLockNote('phr') === PHR.wipe);
  check('…WalletContext\'s fallback when an attempt cannot be checked: "The PIN could not be checked. Try again." / "The passphrase could not be checked. Try again."',
    pinMod.lockCheckFailedMessage('pin') === 'The PIN could not be checked. Try again.' && pinMod.lockCheckFailedMessage('phr') === 'The passphrase could not be checked. Try again.' &&
      read('wallet/WalletContext.tsx').includes('message: e instanceof PinRecordDamagedError ? PIN_DAMAGED_MESSAGE : lockCheckFailedMessage(appLockKind.get()) };') &&
      !read('wallet/WalletContext.tsx').includes("'The PIN could not be checked. Try again.'"));
  const settingsLockNotes = (src) =>
    src.includes('const settingsLockKind = React.useSyncExternalStore(appLockKind.subscribe, appLockKind.get);') &&
    // Phase 23 item 8: shown through the string table (localize), English unchanged.
    src.includes("(appPinOn ? ` ${localize(wipeWithLockNote(settingsLockKind))}` : '')") &&
    src.includes("<T>{settingsLockKind === 'phr' ? AUTO_LOCK_WITH_PASSPHRASE_NOTE : AUTO_LOCK_WITH_PIN_NOTE}</T>") &&
    src.includes("<T>{settingsLockKind === 'phr' ? SCREEN_PROTECTION_WITH_PASSPHRASE_NOTE : SCREEN_PROTECTION_WITH_PIN_NOTE}</T>") &&
    !/WIPE_WITH_PIN_NOTE|\{AUTO_LOCK_WITH_PIN_NOTE\}|\{SCREEN_PROTECTION_WITH_PIN_NOTE\}|\{NOTIFICATIONS_OFF_WITH_PIN\}/.test(src);
  check('Settings: the wipe note, the auto-lock note and the screen-protection note follow the lock\'s kind (source)', settingsLockNotes(settings));
  check('mutant caught (polish): the wipe dialog keeps the PIN note whatever the kind',
    !settingsLockNotes(settings.replace('${localize(wipeWithLockNote(settingsLockKind))}', '${localize(WIPE_WITH_PIN_NOTE)}')));
  check('Settings: turning the PIN on first switches notifications off and clears what was scheduled or shown',
    /await setNotifications\(false\)[\s\S]{0,120}await appNotifications\(\)\.disable\(\)[\s\S]{0,80}await turnOnAppPin\(next!, chosenKind\)/.test(settings));
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
    /\) : appPinOn \? \(\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*<PinPad key=\{awaitingPin \? 'launch' : 'return'\} prompt=\{PIN_PAD_TITLE\} onComplete=\{unlockWithAppPin\} \/>/.test(gate) &&
      gate.includes('const status = lockGateWalletStatus(walletStatus, appPinOn);') && gate.includes('const available = lockGateAvailable(deviceAvailable, appPinOn);'));
  check('LockGate: the tree below is remounted when a PIN opened the other wallet (keyed on profileKey)', gate.includes('<View key={`profile-${profileKey}`} style={styles.fill}>'));
  const ctx = read('wallet/WalletContext.tsx');
  const launchAt = ctx.indexOf('const lockRecord = await readPinRecord(appSecureBackend());');
  check('WalletContext: at launch the PIN record is read BEFORE the phrase location, and nothing loads while a PIN is set',
    launchAt > 0 && launchAt < ctx.indexOf('const location = await phraseLocation();') && /if \(pinOn\) \{\s*awaitingPinRef\.current = true;\s*setAwaitingPin\(true\);\s*return;\s*\}/.test(ctx));
  const unlock = ctx.slice(ctx.indexOf('const unlockWithPin = useCallback('), ctx.indexOf('const checkSessionPin = useCallback('));
  check('WalletContext.unlockWithPin: drops a held phrase and sets the PIN\'s profile BEFORE reloading',
    unlock.indexOf('dropPhraseTicket();') < unlock.indexOf('setActiveStoreProfile(profile);') && unlock.indexOf('setActiveStoreProfile(profile);') < unlock.indexOf('await reloadWallet();') &&
      unlock.includes('const profile = profileForSlot(outcome.slot);'));
  check('WalletContext: only the real wallet can add a duress PIN or remove the PIN; under the second wallet the sentence is neutral',
    // Five since the lock passphrase: switching kinds is the fifth such action.
    (ctx.match(/if \(slot !== 'primary'\) throw new Error\(PIN_ACTION_NOT_COMPLETED\);/g) ?? []).length === 5 &&
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
    // The claim and the backup note of the lock's kind (duress.ts LOCK_COPY; the PIN's are the constants).
    // Phase 23 item 8: the notes through the string table (localizeText), English unchanged.
    settings.includes('<WarningBox>{copy.duressHonestClaim}</WarningBox>') && settings.includes('{localizeText(DURESS_FUNDING_NOTE)}') && settings.includes('{localizeText(copy.duressBackupNote)}') &&
      duressMod.LOCK_COPY.pin.duressHonestClaim === duressMod.DURESS_HONEST_CLAIM && duressMod.LOCK_COPY.pin.duressBackupNote === duressMod.DURESS_BACKUP_NOTE);
  check('the backup check: two distinct positions, uniformly chosen, and the typed words compared case-insensitively',
    (() => {
      const pos = duressMod.backupCheckPositions(12, detRandom);
      return pos[0] !== pos[1] && pos.every((p) => p >= 0 && p < 12) &&
        duressMod.backupWordsMatch(PARENT_12, [0, 11], ['Abandon ', 'ABOUT']) && !duressMod.backupWordsMatch(PARENT_12, [0, 11], ['abandon', 'abandon']) &&
        duressMod.backupCheckLabel([2, 8]) === 'word 3 and word 9';
    })());
}

// ---------------------------------------------------------------------------
console.log('check-duress: the lock passphrase (docs/DURESS_WALLET.md section 8.2, stage P1)');
// ---------------------------------------------------------------------------
// Passphrases used below (made-up test strings, never anyone's secret).
const PHR_A = 'lantern orbit pickle 42 velvet';
const PHR_B = 'quiet harbor ferns 9081 tulip';
// A recovery phrase for the word rule, built from fixed entropy and never
// printed: the repository's secret scan refuses checksum-valid phrases as
// literals (see CHILD_12_SHA256 above).
const WORD_RULE_PHRASE = entropyToMnemonic(sha256(utf8ToBytes('check-duress lock passphrase word rule')).slice(0, 16), wordlist);
const WORD_RULE_SHA256 = sha256Hex(WORD_RULE_PHRASE);
const RULE_WORDS = WORD_RULE_PHRASE.split(' ');

/** A passphrase record with a fast counting KDF, optionally with a duress passphrase. */
async function phrRecord(pin, { duress = null } = {}) {
  const { kdf, calls } = countingKdf();
  const backend = fakeSecureStore();
  const deps = { kdf, random: detRandom, now: () => 1_000 };
  await pin.setAppPin(backend, PHR_A, deps, 'phr');
  if (duress) await pin.setPinSlot(backend, 'duress', duress, deps);
  return { backend, deps, calls };
}

/** The refusals of a new passphrase, by rule, through the one function Settings and the setters use. */
function refusalTable(pin, opts = {}) {
  const r = (t, ctx = {}) => pin.newLockSecretRefusal('phr', t, ctx);
  // n DIFFERENT emoji (one emoji repeated would be refused as one repeated character).
  const emoji = (n) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x1f600 + i)).join('');
  return {
    len14: r('fourteen chars'),
    len15: r('fifteen chars x'),
    len128: r('a'.repeat(64) + 'b'.repeat(64)),
    len129: r('a'.repeat(64) + 'b'.repeat(65)),
    emoji14: r(emoji(14)),
    emoji15: r(emoji(15)),
    combining: pin.codePointLength('cafe\u0301') === 5 && pin.codePointLength('caf\u00e9') === 4 && pin.codePointLength(emoji(15)) === 15 && emoji(15).length === 30,
    leading: r(` ${PHR_A}`),
    trailing: r(`${PHR_A} `),
    trailingNbsp: r(`${PHR_A}\u00a0`),
    newline: r('lantern orbit\npickle velvet'),
    tab: r('lantern orbit\tpickle velvet'),
    illFormed: r('lantern orbit pickle \ud800 velvet'),
    repeated: r('x'.repeat(20)),
    threeWords: r(`${RULE_WORDS[2]} ${RULE_WORDS[5]} ${RULE_WORDS[9]} zq7 vv8`, { phrase: WORD_RULE_PHRASE }),
    threeWordsUpper: r(`${RULE_WORDS[2].toUpperCase()} ${RULE_WORDS[5]} ${RULE_WORDS[9]} zq7 vv8`, { phrase: WORD_RULE_PHRASE }),
    oneWordThrice: r(`${RULE_WORDS[2]} ${RULE_WORDS[2]} ${RULE_WORDS[2]} zq7 vv8`, { phrase: WORD_RULE_PHRASE }),
    twoWords: r(`${RULE_WORDS[2]} ${RULE_WORDS[5]} zq7 vv8 kk9 pp0`, { phrase: WORD_RULE_PHRASE }),
    threeWordsNoPhrase: r(`${RULE_WORDS[2]} ${RULE_WORDS[5]} ${RULE_WORDS[9]} zq7 vv8`),
    nearSuffix: r(`${PHR_A}!`, { appSecret: PHR_A }),
    nearCase: r(PHR_A.toUpperCase(), { appSecret: PHR_A }),
    nearEdits: r('lantern orbit pickle 43 velvex', { appSecret: PHR_A }),
    nearRun: r('zz orbit pickle 77 qq ww', { appSecret: PHR_A }),
    far: r(PHR_B, { appSecret: PHR_A }),
    ok: r(PHR_B),
    ...opts,
  };
}

/** NFKD, the edge strip at entry, and one record opened by equivalent typings. */
async function canonicalOpens(pin) {
  const fullWidth = 'ｌａｎｔｅｒｎ ｏｒｂｉｔ ｐｉｃｋｌｅ 42 ｖｅｌｖｅｔ';
  const { backend, deps } = await phrRecord(pin);
  const viaFullWidth = await pin.attemptPin(backend, fullWidth, deps);
  const viaEdges = await pin.attemptPin(backend, `  ${PHR_A}\u00a0 `, deps);
  // A precomposed "\u00e9" and "e" + a combining accent are the same passphrase.
  const b2 = fakeSecureStore();
  await pin.setAppPin(b2, 'caf\u00e9 orbit pickle velvet', deps, 'phr');
  const viaCombining = await pin.attemptPin(b2, 'cafe\u0301 orbit pickle velvet', deps);
  const b3 = fakeSecureStore();
  await pin.setAppPin(b3, 'the \ufb01fteen \ufb01sh swam home', deps, 'phr');
  const viaLigature = await pin.attemptPin(b3, 'the fifteen fish swam home', deps);
  return { viaFullWidth: viaFullWidth.kind, viaEdges: viaEdges.kind, viaCombining: viaCombining.kind, viaLigature: viaLigature.kind };
}

/** The kind rule: a PIN cannot go into a passphrase lock and the reverse; switching rewrites both slots in ONE write. */
async function kindRule(pin) {
  const out = {};
  const p = await phrRecord(pin);
  try { await pin.setPinSlot(p.backend, 'duress', PIN_B, p.deps); out.pinIntoPhr = 'accepted'; } catch (e) { out.pinIntoPhr = e.message; }
  const { kdf } = countingKdf();
  const pinBackend = fakeSecureStore();
  await pin.setAppPin(pinBackend, PIN_A, { kdf, random: detRandom });
  try { await pin.setPinSlot(pinBackend, 'duress', PHR_B, { kdf, random: detRandom }); out.phrIntoPin = 'accepted'; } catch (e) { out.phrIntoPin = e.message; }
  // Switch the PIN lock (with a duress PIN) to passphrases: one write.
  await pin.setPinSlot(pinBackend, 'duress', PIN_B, { kdf, random: detRandom });
  const writes = [];
  const set = pinBackend.setItemAsync;
  pinBackend.setItemAsync = async (k, v, o) => {
    writes.push(v);
    return set(k, v, o);
  };
  const before = [...pinBackend.items.values()][0];
  try { await pin.setLockSlots(pinBackend, 'phr', PHR_A, `${PHR_A}!`, { kdf, random: detRandom }); out.nearRefused = 'accepted'; } catch (e) { out.nearRefused = e.message; }
  try { await pin.setLockSlots(pinBackend, 'phr', PHR_A, PIN_B, { kdf, random: detRandom }); out.mixedRefused = 'accepted'; } catch (e) { out.mixedRefused = e.message; }
  out.untouchedAfterRefusals = writes.length === 0 && [...pinBackend.items.values()][0] === before;
  await pin.setLockSlots(pinBackend, 'phr', PHR_A, PHR_B, { kdf, random: detRandom });
  out.switchWrites = writes.length;
  out.switchedKind = writes.length > 0 ? JSON.parse(writes.at(-1)).kind : null;
  out.switchedLength = writes.length > 0 ? writes.at(-1).length : null;
  const deps = { kdf, random: detRandom, now: () => 1 };
  out.oldPin = (await pin.attemptPin(pinBackend, PIN_A, deps)).kind;
  const app = await pin.attemptPin(pinBackend, PHR_A, deps);
  const duress = await pin.attemptPin(pinBackend, PHR_B, deps);
  out.app = `${app.kind}:${app.slot}`;
  out.duress = `${duress.kind}:${duress.slot}`;
  // A crash during the one write leaves the old record whole.
  const crash = fakeSecureStore();
  await pin.setAppPin(crash, PIN_A, { kdf, random: detRandom });
  const crashBefore = [...crash.items.values()][0];
  crash.setItemAsync = async () => { throw new Error('app killed during the write'); };
  await pin.setLockSlots(crash, 'phr', PHR_A, null, { kdf, random: detRandom }).catch(() => undefined);
  out.crashKept = [...crash.items.values()][0] === crashBefore;
  // The other slot's passphrase as the new app passphrase: the shared sentence.
  try {
    const q = await phrRecord(pin, { duress: PHR_B });
    try { await pin.setPinSlot(q.backend, 'primary', PHR_B, q.deps); out.otherSlot = 'accepted'; } catch (e) { out.otherSlot = e.message; }
  } catch (e) {
    out.otherSlot = `set-up failed: ${e.message}`;
  }
  return out;
}

/** Pass p21f's slow-hash schedule, for a passphrase lock. */
async function slowPassphrase(pin) {
  const backend = fakeSecureStore();
  let now = 2_000_000;
  let hashes = 0;
  const kdf = async (p, salt) => {
    hashes += 1;
    now += 125_000;
    return sha256(concatBytes(salt, utf8ToBytes(p)));
  };
  const deps = { kdf, random: detRandom, now: () => now };
  await pin.setAppPin(backend, PHR_A, { ...deps, kdf: countingKdf().kdf }, 'phr');
  const outs = [];
  for (let i = 1; i <= 5; i += 1) outs.push(await pin.attemptPin(backend, PHR_B, deps));
  const fifth = outs[4];
  const visible = pin.pinAttemptMessage(fifth, now);
  now += 1_000;
  hashes = 0;
  const during = await pin.attemptPin(backend, PHR_A, deps);
  const duringHashes = hashes;
  const duringText = pin.pinAttemptMessage(during, now);
  const countdown = pin.pinCountdownOf(during);
  const over = countdown ? pin.pinCountdownText(countdown, during.until) : null;
  // A malformed entry (too short) after the wait: both hashes, counted.
  now = during.until;
  hashes = 0;
  const short = await pin.attemptPin(backend, 'short', deps);
  const shortHashes = hashes;
  now = short.until > now ? short.until : now;
  const ok = await pin.attemptPin(backend, PHR_A, deps);
  return {
    first: pin.pinAttemptMessage(outs[0], now),
    visible,
    during: during.kind,
    duringHashes,
    duringText,
    over,
    countdownLock: countdown?.lock ?? null,
    short: short.kind,
    shortFails: short.fails,
    shortHashes,
    ok: ok.kind,
  };
}

/** The kind is read before any wallet: one read, of the PIN record's name only. */
async function kindDetection(pin) {
  const backend = fakeSecureStore();
  const none = await pin.readLockKind(backend);
  const { kdf } = countingKdf();
  await pin.setAppPin(backend, PHR_A, { kdf, random: detRandom }, 'phr');
  backend.log.length = 0;
  const kind = await pin.readLockKind(backend);
  return { none, kind, reads: backend.log.map(([op, k]) => `${op}:${k}`) };
}

/** A version 1 record (written before passphrases) as stored text: the v2 text without `kind`, v = 1. */
function asVersion1(v2text) {
  const o = JSON.parse(v2text);
  return JSON.stringify({ v: 1, kdf: o.kdf, N: o.N, r: o.r, p: o.p, slots: o.slots, fails: o.fails, until: o.until });
}
async function version1(pin) {
  const { kdf } = countingKdf();
  const deps = { kdf, random: detRandom, now: () => 1 };
  const backend = fakeSecureStore();
  await pin.setAppPin(backend, PIN_A, deps);
  const id = [...backend.items.keys()][0];
  const v1 = asVersion1(backend.items.get(id));
  backend.items.set(id, v1);
  const decoded = pin.decodePinRecord(v1);
  const opened = await pin.attemptPin(backend, PIN_A, deps);
  const after = backend.items.get(id);
  const damaged = (text) => {
    try { pin.decodePinRecord(text); return false; } catch (e) { return e instanceof pin.PinRecordDamagedError; }
  };
  const v2 = JSON.parse(after);
  const v1WithKind = JSON.stringify({ ...JSON.parse(v1), kind: 'pin' });
  const v2NoKind = JSON.stringify({ ...v2, v: 2, kind: undefined });
  const v2Unknown = after.replace('"kind":"pin"', '"kind":"pix"');
  return {
    v1Length: v1.length,
    decodedKind: decoded.kind,
    decodedV: decoded.v,
    opened: `${opened.kind}:${opened.slot}`,
    afterLength: after.length,
    afterV: v2.v,
    afterKind: v2.kind,
    sameSlots: JSON.stringify(v2.slots) === JSON.stringify(JSON.parse(v1).slots),
    refused: [v1WithKind, v2NoKind, v2Unknown].map(damaged),
  };
}

/** The LockGate / Settings / WalletContext sources of the passphrase path. */
function passphraseSources(gate, settings, ctx) {
  const field = gate.slice(gate.indexOf('export function PassphraseField('), gate.indexOf('const styles = StyleSheet.create('));
  const props = ['secureTextEntry\n', 'autoCorrect={false}', 'spellCheck={false}', 'autoComplete="off"', 'importantForAutofill="no"', 'textContentType="none"', 'autoCapitalize="none"', 'contextMenuHidden\n', 'maxLength={256}'];
  return {
    props: props.every((p) => field.includes(p)),
    capture: field.includes("usePreventScreenCapture('pin-pad');"),
    clearedFirst: field.indexOf("setText('');") > 0 && field.indexOf("setText('');") < field.indexOf('onComplete(value)'),
    noShowToggle: !/secureTextEntry=\{/.test(field),
    named: field.includes("const field = fieldLabel('lock-passphrase', prompt);") && field.includes('{...field.input}') && field.includes('<Text {...field.label}'),
    lockScreen: /\{appPinOn && lockKind === 'phr' \? \([\s\S]{0,300}<PassphraseField[\s\S]{0,120}prompt=\{lockCopy\('phr'\)\.lockScreenPrompt\}/.test(gate) &&
      gate.includes('const lockKind = useSyncExternalStore(appLockKind.subscribe, appLockKind.get);'),
    launchKind: ctx.indexOf('if (lockRecord) appLockKind.set(lockRecord.kind);') > 0 &&
      ctx.indexOf('if (lockRecord) appLockKind.set(lockRecord.kind);') < ctx.indexOf('const location = await phraseLocation();'),
    switchDecoy: /const switchAppLockKind = useCallback\([\s\S]{0,200}const slot = await checkSessionPin\(currentSecret\);[\s\S]{0,300}if \(slot !== 'primary'\) throw new Error\(PIN_ACTION_NOT_COMPLETED\);[\s\S]{0,400}await setLockSlots\(/.test(ctx),
    settingsRule: settings.includes('const refusal = newLockSecretRefusal(kind, secret, { phrase: held.current.phrase, appSecret });') &&
      settings.includes('await switchAppLockKind(current!, flowKind(flow), next!, held.current.duressNext);') &&
      settings.includes('<PassphraseField key={`${step.flow}-${step.stage}`} prompt={padPrompt(step)} submitLabel="Continue" onComplete={onPad} />'),
  };
}

{
  // The record, version 2, byte for byte.
  const fixed = { v: 2, kind: 'phr', slots: [new Uint8Array(64), new Uint8Array(64).fill(0xff)], fails: 3, until: 1000 };
  const expected = `{"v":2,"kdf":"scrypt","N":65536,"r":8,"p":1,"kind":"phr","slots":["${'00'.repeat(64)}","${'ff'.repeat(64)}"],"fails":"00000003","until":"0000000003e8"}`;
  const enc = pinMod.encodePinRecord(fixed);
  check('version 2 byte for byte: v, kdf, N, r, p, then "kind" (3 characters), the two 64-byte slots, the fixed-width counter and wait',
    enc === expected, enc);
  check('…371 characters for "pin" and for "phr" alike (the kind\'s value has one width), with or without a duress slot',
    enc.length === 371 && pinMod.encodePinRecord({ ...fixed, kind: 'pin' }).length === 371 && pinMod.PIN_RECORD_LENGTH === 371);
  const ph = await phrRecord(pinMod, { duress: PHR_B });
  const lens = [];
  const set = ph.backend.setItemAsync;
  ph.backend.setItemAsync = async (k, v, o) => { lens.push(v.length); return set(k, v, o); };
  for (const t of [PHR_A, PHR_B, 'wrong passphrase here', 'x']) await pinMod.attemptPin(ph.backend, t, ph.deps);
  await pinMod.setPinSlot(ph.backend, 'primary', 'a much longer passphrase than the first one, typed only for this check', ph.deps);
  check(`a passphrase record is 371 bytes on every write, whatever the passphrases' lengths (${lens.length} writes)`,
    lens.length === 9 && lens.every((l) => l === 371), JSON.stringify(lens));

  const v = await version1(pinMod);
  check('a version 1 record (358 bytes, no kind) reads as kind "pin" and opens with the same PIN',
    v.v1Length === 358 && v.decodedKind === 'pin' && v.decodedV === 1 && v.opened === 'opened:primary', JSON.stringify(v));
  check('…and the first write converts it: version 2, kind "pin", 371 bytes, the same slots',
    v.afterLength === 371 && v.afterV === 2 && v.afterKind === 'pin' && v.sameSlots, JSON.stringify(v));
  check('a version 1 record with a kind, a version 2 record without one, and an unknown kind are damaged (never read as "no lock")',
    v.refused.every(Boolean), JSON.stringify(v.refused));

  const t = refusalTable(pinMod);
  check('length in code points as typed: 14 refused, 15 accepted, 128 accepted, 129 refused ("A passphrase has 15 to 128 characters.")',
    t.len14 === 'A passphrase has 15 to 128 characters.' && t.len15 === null && t.len128 === null && t.len129 === pinMod.PASSPHRASE_LENGTH_MESSAGE, JSON.stringify(t));
  check('…an emoji is one code point (14 refused, 15 accepted although 30 UTF-16 units); "e" + a combining accent is two, a precomposed "\u00e9" one',
    t.emoji14 === pinMod.PASSPHRASE_LENGTH_MESSAGE && t.emoji15 === null && t.combining);
  check('edge whitespace refused at set-up, leading, trailing and a no-break space ("A passphrase cannot begin or end with a space.")',
    [t.leading, t.trailing, t.trailingNbsp].every((x) => x === 'A passphrase cannot begin or end with a space.'));
  check('a line break or a tab inside refused ("A passphrase cannot contain line breaks or other control characters."); ill-formed Unicode refused with its own sentence',
    t.newline === 'A passphrase cannot contain line breaks or other control characters.' && t.tab === pinMod.PASSPHRASE_CONTROL_MESSAGE &&
      t.illFormed === 'This passphrase contains a character that is not valid text. Type it again.');
  check('the control-character test is exactly Unicode category Cc: equal to Node\'s /\\p{Cc}/u over every BMP code point (65 of them)',
    (() => {
      let n = 0;
      for (let cp = 0; cp <= 0xffff; cp += 1) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const ch = String.fromCharCode(cp);
        const want = /\p{Cc}/u.test(ch);
        if (want) n += 1;
        if (pinMod.hasControlCharacter(ch) !== want) return false;
      }
      return n === 65;
    })());
  check('one repeated character: the shared sentence ("This passphrase cannot be used. Choose a different passphrase.")',
    t.repeated === 'This passphrase cannot be used. Choose a different passphrase.');
  check('the test recovery phrase is the one built here from fixed entropy (never printed; pinned by its SHA-256)',
    WORD_RULE_SHA256 === sha256Hex(entropyToMnemonic(sha256(utf8ToBytes('check-duress lock passphrase word rule')).slice(0, 16), wordlist)) && RULE_WORDS.length === 12);
  check('three words of the open wallet\'s recovery phrase refused ("Do not use words from your recovery phrase in your passphrase."), in any case; two accepted; one word typed three times counts once',
    t.threeWords === 'Do not use words from your recovery phrase in your passphrase.' && t.threeWordsUpper === pinMod.PASSPHRASE_PHRASE_WORDS_MESSAGE &&
      t.twoWords === null && t.oneWordThrice === null, JSON.stringify([t.threeWords, t.twoWords, t.oneWordThrice]));
  check('…the rule needs the phrase: without it the same passphrase passes the plaintext rules (so the flow must open the phrase)', t.threeWordsNoPhrase === null);
  check('a duress passphrase too close to the app passphrase (a suffix, another case, 2 edits, a shared run of 12): the shared sentence; an unrelated one passes',
    [t.nearSuffix, t.nearCase, t.nearEdits, t.nearRun].every((x) => x === pinMod.PASSPHRASE_NOT_USABLE_MESSAGE) && t.far === null && t.ok === null,
    JSON.stringify([t.nearSuffix, t.nearCase, t.nearEdits, t.nearRun, t.far]));
  check('the PIN rules are unchanged through the same function (6 digits; trivially guessed refused with the PIN\'s shared sentence)',
    pinMod.newLockSecretRefusal('pin', '12345') === pinMod.PIN_FORMAT_MESSAGE && pinMod.newLockSecretRefusal('pin', '123456') === pinMod.PIN_NOT_USABLE_MESSAGE &&
      pinMod.newLockSecretRefusal('pin', PIN_A) === null && pinMod.isTriviallyGuessed('000000'));

  // NFKD: the same rule as @scure/bip39 (whose nfkd is not exported).
  const samples = ['ｆｕｌｌ ｗｉｄｔｈ', '\ufb01sh', 'caf\u00e9', 'cafe\u0301', '\u{1F600} smile', 'plain ascii'];
  check('bip39Nfkd is @scure/bip39\'s normalisation: mnemonicToSeedSync(m, p) equals mnemonicToSeedSync(m, bip39Nfkd(p)) for six samples (full width, a ligature, both forms of \u00e9, an emoji)',
    samples.every((p) => bytesToHex(mnemonicToSeedSync(PARENT_12, p)) === bytesToHex(mnemonicToSeedSync(PARENT_12, pinMod.bip39Nfkd(p)))) &&
      pinMod.bip39Nfkd('ｆｕｌｌ') === 'full' && pinMod.bip39Nfkd('\ufb01') === 'fi' && pinMod.bip39Nfkd('caf\u00e9') === pinMod.bip39Nfkd('cafe\u0301'));
  check('…and both refuse ill-formed Unicode (a lone surrogate) where the library throws',
    (() => {
      let lib = false;
      let ours = false;
      try { mnemonicToSeedSync(PARENT_12, 'x\ud800'); } catch { lib = true; }
      try { pinMod.bip39Nfkd('x\ud800'); } catch { ours = true; }
      return lib && ours;
    })());
  const c = await canonicalOpens(pinMod);
  check('one record opens with equivalent typings: full-width letters (NFKD, not NFC), edge spaces stripped at entry, "\u00e9" either way, the "\ufb01" ligature',
    c.viaFullWidth === 'opened' && c.viaEdges === 'opened' && c.viaCombining === 'opened' && c.viaLigature === 'opened', JSON.stringify(c));

  const k = await kindRule(pinMod);
  check('mixed kinds refused: a PIN cannot be set into a passphrase lock, nor a passphrase into a PIN lock (each refused by the record\'s form)',
    k.pinIntoPhr === pinMod.PASSPHRASE_LENGTH_MESSAGE && k.phrIntoPin === pinMod.PIN_FORMAT_MESSAGE, JSON.stringify(k));
  check('switching kinds: a near-copy duress passphrase and a PIN-form duress secret are refused with nothing written',
    k.nearRefused === pinMod.PASSPHRASE_NOT_USABLE_MESSAGE && k.mixedRefused === pinMod.PASSPHRASE_LENGTH_MESSAGE && k.untouchedAfterRefusals, JSON.stringify(k));
  check('…and the switch rewrites BOTH slots in ONE write (kind "phr", 371 bytes): the old PIN is wrong, the new app passphrase opens the real wallet, the new duress passphrase the second',
    k.switchWrites === 1 && k.switchedKind === 'phr' && k.switchedLength === 371 && k.oldPin === 'wrong' && k.app === 'opened:primary' && k.duress === 'opened:duress', JSON.stringify(k));
  check('…a crash during that one write leaves the old record whole (never two kinds)', k.crashKept);
  check('the other slot\'s passphrase as a new passphrase: refused by hash, with the shared sentence', k.otherSlot === pinMod.PASSPHRASE_NOT_USABLE_MESSAGE, k.otherSlot);

  const s = await slowPassphrase(pinMod);
  check('the lockout for a passphrase: "Wrong passphrase. Try again." then, after 5, "Wrong passphrase. Try again in 30 seconds." from the end of the attempt',
    s.first === 'Wrong passphrase. Try again.' && s.visible === 'Wrong passphrase. Try again in 30 seconds.', JSON.stringify(s));
  check('…during the wait refused at once with no hash ("Too many wrong passphrases. Try again in 29 seconds."), then "You can enter your passphrase again."',
    s.during === 'wait' && s.duringHashes === 0 && s.duringText === 'Too many wrong passphrases. Try again in 29 seconds.' &&
      s.over === 'You can enter your passphrase again.' && s.countdownLock === 'phr', JSON.stringify(s));
  check('…a malformed entry (too short) still costs both hashes and counts as a wrong attempt; the right passphrase after the wait opens',
    s.short === 'wrong' && s.shortHashes === 2 && s.shortFails === 6 && s.ok === 'opened', JSON.stringify(s));
  check('a PIN lock\'s countdown carries no kind (byte-identical to before), a passphrase lock\'s carries "phr"',
    JSON.stringify(pinMod.pinCountdownOf({ kind: 'wrong', fails: 5, until: 9, lock: 'pin' })) === '{"kind":"wrong","until":9}' &&
      JSON.stringify(pinMod.pinCountdownOf({ kind: 'wait', until: 9, lock: 'phr' })) === '{"kind":"wait","until":9,"lock":"phr"}');

  const d = await kindDetection(pinMod);
  check('the lock screen learns the kind before any wallet: null with no record, "phr" from ONE read of the PIN record\'s name and nothing else',
    d.none === null && d.kind === 'phr' && d.reads.join() === 'get:shiba-wallet.app-lock.v1', JSON.stringify(d));
  check('appLockKind (memory only) starts as "pin", follows set, and notifies its subscribers once per change',
    (() => {
      let n = 0;
      const un = duressMod.appLockKind.subscribe(() => { n += 1; });
      const start = duressMod.appLockKind.get();
      duressMod.appLockKind.set('phr');
      duressMod.appLockKind.set('phr');
      const mid = duressMod.appLockKind.get();
      duressMod.appLockKind.set('pin');
      un();
      return start === 'pin' && mid === 'phr' && n === 2 && duressMod.appLockKind.get() === 'pin';
    })());

  // Both scrypt paths: the same bytes for a non-ASCII passphrase.
  const salt = detRandom(32);
  const input = pinMod.lockSecretInput('phr', '  ｃａｆ\u00e9 \ufb01sh \u{1F600} orbit pickle  ');
  nativeMod.setNativeScryptLoaderForChecks(async () => ({ kind: 'absent' }));
  const viaJs = await pinMod.pinScrypt(input, salt, 12);
  const nat = nodeNative();
  nativeMod.setNativeScryptLoaderForChecks(nat.loader);
  const viaNative = await pinMod.pinScrypt(input, salt, 12);
  nativeMod.setNativeScryptLoaderForChecks(null);
  const viaNode = new Uint8Array(scryptSync(Buffer.from(utf8ToBytes(input)), salt, 32, { N: 4096, r: 8, p: 1 }));
  check('a non-ASCII passphrase (full width, \u00e9, a ligature, an emoji) hashes to the same bytes through noble, through the native stand-in and through Node\'s scrypt over its UTF-8 bytes',
    input === 'cafe\u0301 fish \u{1F600} orbit pickle' && bytesToHex(viaJs) === bytesToHex(viaNative) && bytesToHex(viaJs) === bytesToHex(viaNode) &&
      nat.calls.length === 2 && bytesToHex(nat.calls[1].input) === bytesToHex(utf8ToBytes(input)), input);
  // A real passphrase record (real scrypt, N = 2^16): set with JavaScript, opened natively.
  nativeMod.setNativeScryptLoaderForChecks(async () => ({ kind: 'absent' }));
  const realPhr = fakeSecureStore();
  await pinMod.setAppPin(realPhr, PHR_A, { random: detRandom }, 'phr');
  nativeMod.setNativeScryptLoaderForChecks(nodeNative().loader);
  const realOpen = await pinMod.attemptPin(realPhr, `${PHR_A} `, { random: detRandom });
  nativeMod.setNativeScryptLoaderForChecks(null);
  const realSlot = (await pinMod.readPinRecord(realPhr)).slots[0];
  check('a real passphrase slot is scrypt(NFKD passphrase, salt, N = 2^16), set with JavaScript and opened through the native path',
    realOpen.kind === 'opened' && realOpen.slot === 'primary' &&
      bytesToHex(realSlot.subarray(32)) === bytesToHex(scrypt(PHR_A, realSlot.subarray(0, 32), { N: 65536, r: 8, p: 1, dkLen: 32 })));

  check('the forced settings take no kind: effectivePrefs is keyed only on "a lock is set", so a passphrase forces auto-lock, protection and notifications exactly as a PIN',
    duressMod.effectivePrefs.length === 2 && /export function effectivePrefs\(\s*prefs: \{[^}]*\},\s*appPinOn: boolean,\s*\)/.test(read('wallet/duress.ts')));

  const src = passphraseSources(read('components/LockGate.tsx'), read('screens/SettingsScreen.tsx'), read('wallet/WalletContext.tsx'));
  check('PassphraseField: secure entry, autocorrect / spell-check / autocomplete / autofill / content type off, no capitalisation, no context menu, a typing guard (source scan)',
    src.props, JSON.stringify(src));
  check('…capture blocked with the pad\'s key, the text cleared BEFORE the check, no Show toggle, named by its visible prompt',
    src.capture && src.clearedFirst && src.noShowToggle && src.named, JSON.stringify(src));
  check('LockGate shows the field for a passphrase lock ("Enter your passphrase"), from the kind read with the record at launch, before the phrase location',
    src.lockScreen && src.launchKind && duressMod.LOCK_COPY.phr.lockScreenPrompt === 'Enter your passphrase', JSON.stringify(src));
  check('switching kinds checks the current secret and, in the second wallet, ends with the neutral sentence before anything is written',
    src.switchDecoy, JSON.stringify(src));
  check('Settings checks every new secret with newLockSecretRefusal, given the open phrase and the app secret of the same flow, and switches through switchAppLockKind',
    src.settingsRule, JSON.stringify(src));

  const copy = duressMod.LOCK_COPY;
  check('the copy per kind: section 8.2.9\'s passphrase prompts, advice, keyboard note, limits note and honest claim verbatim; the PIN\'s copy is the existing constants',
    copy.phr.prompts.choose === 'Choose a passphrase' && copy.phr.prompts.chooseAgain === 'Type the passphrase again' &&
      copy.phr.prompts.chooseDuress === 'Choose a duress passphrase' && copy.phr.prompts.chooseDuressAgain === 'Type the duress passphrase again' &&
      copy.phr.prompts.current === 'Type your current passphrase' &&
      duressMod.PASSPHRASE_ADVICE.startsWith('A passphrase is typed on your keyboard each time the wallet opens. Use four or more random words') &&
      duressMod.PASSPHRASE_KEYBOARD_NOTE === 'Unlike the PIN pad, your keyboard sees what you type. Use a keyboard you trust.' &&
      copy.phr.limitsNote.startsWith("What the passphrase does not protect against: someone who copies this app's storage") &&
      copy.pin.prompts.current === duressMod.PIN_PROMPTS.current && copy.pin.limitsNote === duressMod.APP_PIN_LIMITS_NOTE &&
      duressMod.APP_LOCK_SWITCH_LABEL === 'Use a PIN or passphrase to unlock' &&
      duressMod.APP_LOCK_KIND_CHOICES.pin === '6-digit PIN' && duressMod.APP_LOCK_KIND_CHOICES.phr === 'Passphrase (15 to 128 characters)');
  const claimPhr = copy.phr.duressHonestClaim;
  check('the passphrase\'s honest claim has the three parts and three sentences; the readiness reason is kind-neutral',
    claimPhr.includes('someone looking at the screen sees an ordinary wallet.') && claimPhr.includes("Anyone who copies this app's files from the phone can tell that two wallets exist") &&
      /Funding the second wallet from this wallet links them on-chain\.$/.test(claimPhr) && claimPhr.split(/(?<=\.)\s+/).length === 3 &&
      duressMod.DURESS_READINESS_REASON.includes('a 6-digit PIN or a short passphrase can be guessed from such a copy'));
  check('the strength stated honestly: a 6-digit PIN about 20 bits, four dice words about 52, and "the 15-character minimum cannot measure that"',
    duressMod.LOCK_STRENGTH_NOTE.includes('a 6-digit PIN is one of a million (about 20 bits)') && duressMod.LOCK_STRENGTH_NOTE.includes('about 52 bits') &&
      duressMod.LOCK_STRENGTH_NOTE.endsWith('the 15-character minimum cannot measure that.'));
  check('…and no copy of either kind says "undetectable", "hidden" or "invisible"',
    Object.values(copy).every((c) => JSON.stringify(c).match(/undetectable|hidden|invisible/i) === null));
}

// ---------------------------------------------------------------------------
console.log('check-duress: mutants (each must be caught)');
// ---------------------------------------------------------------------------
const MUTANT_DIR = join(HERE, `.mutants-duress-${process.pid}`);
mkdirSync(MUTANT_DIR, { recursive: true });
let mutantNo = 0;
/** Imports a copy of src/wallet/<file> with one replacement; relative imports point at the real modules. */
async function mutant(file, from, to, ...more) {
  const src = read(`wallet/${file}`);
  const pairs = [[from, to], ...more];
  let text = src;
  for (const [a, b] of pairs) {
    if (!text.includes(a)) throw new Error(`mutant anchor missing in ${file}: ${a}`);
    text = text.replace(a, b);
  }
  const realDir = pathToFileURL(join(SRC, 'wallet')).href;
  const srcDir = pathToFileURL(SRC).href;
  text = text.replace(/from '\.\/([^']+)'/g, (_, p) => `from '${realDir}/${p}'`).replace(/from '\.\.\/([^']+)'/g, (_, p) => `from '${srcDir}/${p}'`);
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
    const m = await mutant('pin.ts', 'const m = await matchSlots(record, input, dd);\n  const slot', 'const m = { primary: false, duress: false };\n  const slot');
    // (The counter write before the hashes is the next mutant.)
    const c = await hashCounts(m);
    check('mutant caught: an attempt that computes no hash at all', c.primary.calls !== 2 || c.primary.kind !== 'opened');
  }
  {
    const m = await mutant('pin.ts', "  await writePinRecord(backend, { ...record, fails, until: 0 });\n  // A malformed", '  // A malformed');
    check('mutant caught: the counter written only after the hashes (an attempt killed mid-hash would not count)', (await preIncrement(m)) !== 1);
  }
  {
    const m = await mutant('pin.ts', 'if (fails < PIN_FREE_ATTEMPTS) return 0;', 'if (fails < PIN_FREE_ATTEMPTS - 1) return 0;');
    check('mutant caught: the first wait after 4 wrong PINs instead of 5', JSON.stringify((await schedule(m)).seen) !== JSON.stringify(EXPECTED_SCHEDULE));
  }
  {
    const m = await mutant('pin.ts', 'return { v: 2, kind, slots: [await slotFor(lockSecretInput(kind, pin), dd), randomSlot(dd)], fails: 0, until: 0 };',
      'return { v: 2, kind, slots: [await slotFor(lockSecretInput(kind, pin), dd), new Uint8Array(64)], fails: 0, until: 0 };');
    const before = (await recordShape(m));
    // An all-zero unset slot gives a duress PIN away to anyone who reads the record.
    const raw = m.encodePinRecord(await m.createPinRecord(PIN_A, { kdf: countingKdf().kdf, random: detRandom }));
    check('mutant caught: an unset duress slot that is not random (all zeros) — its content would reveal "no duress PIN"',
      JSON.parse(raw).slots[1] === '0'.repeat(128) && before.lengthOnly === 371 &&
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
    // Pass p21f: the wait stamped when the attempt STARTED (the old rule).
    const m = await mutant('pin.ts',
      "  if (record.until > dd.now()) return { kind: 'wait', until: record.until, lock };",
      "  const startedAt = dd.now();\n  if (record.until > startedAt) return { kind: 'wait', until: record.until, lock };",
      ['const until = wait > 0 ? dd.now() + wait : 0;', 'const until = wait > 0 ? startedAt + wait : 0;']);
    const slow = await slowAttempts(m);
    check('mutant caught: the wait stamped when the attempt started (it has run out before "Wrong PIN" shows)',
      slow.visible !== 'Wrong PIN. Try again in 30 seconds.' || slow.during !== 'wait');
  }
  {
    const m = await mutant('pin.ts', "  if (record.until > dd.now()) return { kind: 'wait', until: record.until, lock };\n", '');
    const slow = await slowAttempts(m);
    check('mutant caught: an attempt during the wait that is checked anyway (hashes computed)', slow.during !== 'wait' || slow.duringHashes !== 0);
  }
  {
    const m = await mutant('pin.ts', "    await writePinRecord(backend, { ...record, fails: 0, until: 0 });\n    return { kind: 'opened', slot, lock };", "    return { kind: 'opened', slot, lock };");
    check('mutant caught: a correct PIN that does not reset the counter', (await slowAttempts(m)).resetFails !== 0);
  }
  {
    const m = await mutant('pin.ts', 'export const PIN_MAX_WAIT_SECONDS = 3_600;', 'export const PIN_MAX_WAIT_SECONDS = 7_200;');
    check('mutant caught: a 2-hour cap', m.pinWaitSeconds(13) !== 3600);
  }
  {
    const m = await mutant('pin-cost.ts', "        if (now() - t0 > PIN_COST_CEILING_MS) throw new PinCostStopped('ceiling');\n", '');
    const r = await fakeCostRun(m, { 12: 1_000, 13: 60_000, 14: 300_000, 15: 1, 16: 1 });
    check('mutant caught: no per-size ceiling (a 300-second size runs to the end and the larger ones still run)', r.report.rows[2].status !== 'ceiling');
  }
  {
    // A measurement that times its own scrypt (here: noble's directly, with r = 4) instead of the PIN's function.
    const cost = read('wallet/pin-cost.ts');
    const mutated = cost.replace('const hash = deps.hash ?? pinScrypt;', "const hash = deps.hash ?? ((i, s, n) => scryptAsync(i, s, { N: 2 ** n, r: 4, p: 1 }));");
    check('mutant caught: a measurement that does not use the PIN\'s own scrypt function', mutated !== cost && !sameScryptPin(read('wallet/pin.ts'), mutated));
    const pinMut = read('wallet/pin.ts').replace('const opts = { N: 2 ** log2N, r: PIN_SCRYPT.r,', 'const opts = { N: 2 ** log2N, r: 4,');
    check('mutant caught: the shared function with a different r than the PIN record states', !sameScryptPin(pinMut, cost));
  }
  {
    const m = await mutant('pin-native-scrypt.ts', 'const problem = await nativeScryptSelfCheck(load.derive);', 'const problem = null;');
    m.setNativeScryptLoaderForChecks(nodeNative({ corrupt: true }).loader);
    check('mutant caught: a native scrypt used without its RFC 7914 self-check (a wrong native output would be trusted)',
      (await m.resolvePinHashPath()).kind === 'native');
  }
  {
    const m = await mutant('pin-native-scrypt.ts', 'return 128 * r * N + PIN_SCRYPT_MAXMEM_HEADROOM;', 'return 128 * r * N;');
    let refused = false;
    try { scryptSync('x', 'y', 32, { N: 65536, r: 8, p: 1, maxmem: m.pinScryptMaxmem(65536, 8) }); } catch { refused = true; }
    check('mutant caught: a maxmem without headroom (OpenSSL refuses N = 2^16 at exactly 128·r·N)', refused);
  }
  {
    const m = await mutant('pin.ts', '      noteNativeScryptFailure(e);\n', '      throw e;\n');
    nativeMod.setNativeScryptLoaderForChecks(nodeNative({ failAtN: 2 ** 12 }).loader);
    let threw = false;
    try { await m.pinScrypt(PIN_A, detRandom(32), 12); } catch { threw = true; }
    nativeMod.setNativeScryptLoaderForChecks(null);
    check('mutant caught: a failed native hash that is not retried with the JavaScript scrypt (the PIN check would fail)', threw);
  }
  {
    const m = await mutant('pin-cost.ts', "      if (ms > PIN_COST_CEILING_MS) stop = 'ceiling';\n", '');
    let now = 0;
    const r = await m.measurePinHashCost({ os: 'android', hermes: true, dev: false }, {
      now: () => now, random: detRandom, hashPath: async () => ({ kind: 'native' }),
      hash: async (i, s, n) => { now += n === 13 ? 130_000 : 1; return new Uint8Array(32); },
    });
    check('mutant caught: on the native path a size past the limit no longer stops the larger sizes', r.rows[2].status !== 'skipped');
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
  // --- the lock passphrase (section 8.2.11) ---
  {
    const m = await mutant('pin.ts', "return isWellFormedUnicode(stripped) ? stripped.normalize('NFKD') : stripped;", "return isWellFormedUnicode(stripped) ? stripped.normalize('NFC') : stripped;");
    const c = await canonicalOpens(m);
    check('mutant caught: NFC instead of NFKD (full-width letters and the "\ufb01" ligature no longer open the record)', c.viaFullWidth !== 'opened' || c.viaLigature !== 'opened');
  }
  {
    const m = await mutant('pin.ts', "  if (kind === 'pin') return typed;\n  const stripped = typed.trim();", "  if (kind === 'pin') return typed;\n  const stripped = typed;");
    check('mutant caught: no edge strip at entry (a stray space makes the right passphrase wrong)', (await canonicalOpens(m)).viaEdges !== 'opened');
  }
  {
    const m = await mutant('pin.ts', "  if (/^\\s|\\s$/.test(typed)) return PASSPHRASE_EDGE_SPACE_MESSAGE;\n", '');
    check('mutant caught: edge whitespace accepted at set-up (a passphrase with a trailing space could never be typed again)', refusalTable(m).trailing === null);
  }
  {
    const m = await mutant('pin.ts', 'return [...text].length;', 'return text.length;');
    const t = refusalTable(m);
    check('mutant caught: length counted in UTF-16 units (14 emoji accepted)', t.emoji14 === null);
  }
  {
    const m = await mutant('pin.ts', 'if (context.phrase && recoveryWordsIn(canonical, context.phrase) > PASSPHRASE_MAX_PHRASE_WORDS)', 'if (false && context.phrase)');
    check('mutant caught: the recovery-word rule that never reads the phrase (three words accepted)', refusalTable(m).threeWords === null);
  }
  {
    const m = await mutant('pin.ts', '  const kind = record.kind;\n  const form = newLockSecretFormatError(kind, newPin);', "  const kind: LockKind = 'pin';\n  const form = newLockSecretFormatError(kind, newPin);");
    const k = await kindRule(m);
    check('mutant caught: mixed kinds allowed (a duress PIN set into a passphrase lock)', k.pinIntoPhr === 'accepted');
  }
  {
    const m = await mutant('pin.ts', '  await writePinRecord(backend, { ...record, kind, slots });\n}',
      '  await writePinRecord(backend, { ...record, kind, slots: [slots[0], record.slots[1]] });\n  await writePinRecord(backend, { ...record, kind, slots });\n}');
    const k = await kindRule(m);
    check('mutant caught: a kind switch written in two writes (a crash between them leaves two kinds of secret)', k.switchWrites !== 1);
  }
  {
    const m = await mutant('pin.ts', '  if (newLockSecretRefusal(kind, newPin) !== null || collides) throw new Error(notUsableMessage(kind));',
      "  if (collides) throw new Error('This passphrase is already used for the other wallet.');\n  if (newLockSecretRefusal(kind, newPin) !== null) throw new Error(notUsableMessage(kind));");
    check('mutant caught: a distinct sentence for the other-slot case (it would tell the second wallet\'s user the real passphrase)',
      (await kindRule(m)).otherSlot !== pinMod.PASSPHRASE_NOT_USABLE_MESSAGE);
  }
  {
    const m = await mutant('pin.ts', 'const v1 = p?.v === 1 &&', 'const v1 = false && p?.v === 1 &&');
    check('mutant caught: version 1 records refused (every existing PIN would stop opening)', await version1(m).then((v) => v.opened !== 'opened:primary').catch(() => true));
  }
  {
    const m = await mutant('pin.ts', '  const input = lockSecretInput(lock, pin);\n',
      "  const input = lockSecretInput(lock, pin);\n  if (!lockEntryWellFormed(lock, pin)) return { kind: 'wrong', fails, until: 0, lock };\n");
    const s = await slowPassphrase(m);
    check('mutant caught: a fast refusal of a malformed passphrase (no hashes: the lock screen would reveal the minimum length by timing)', s.shortHashes !== 2);
  }
  {
    const m = await mutant('pin.ts', "  if (isOneRepeatedCharacter(canonical)) return PASSPHRASE_NOT_USABLE_MESSAGE;\n", '');
    check('mutant caught: one repeated character accepted', refusalTable(m).repeated === null);
  }
  {
    const m = await mutant('pin.ts', "  if (context.appSecret && isNearCopy(context.appSecret, typed)) return PASSPHRASE_NOT_USABLE_MESSAGE;\n", '');
    check('mutant caught: a near copy of the app passphrase accepted as the duress passphrase', refusalTable(m).nearSuffix === null);
  }
  {
    // Phase 22 item 6: the words are string-table ids now (English unchanged).
    const m = await mutant('pin.ts', "  phr: { wrong: 'lock.phr.wrong', tooMany: 'lock.phr.tooMany', over: 'lock.phr.waitOver' },",
      "  phr: { wrong: 'lock.pin.wrong', tooMany: 'lock.pin.tooMany', over: 'lock.pin.waitOver' },");
    check('mutant caught: a passphrase lock that speaks of a PIN on the lock screen', (await slowPassphrase(m)).visible !== 'Wrong passphrase. Try again in 30 seconds.');
  }
  {
    const gate = read('components/LockGate.tsx');
    const settings = read('screens/SettingsScreen.tsx');
    const ctx = read('wallet/WalletContext.tsx');
    const props = ['        contextMenuHidden\n', '        importantForAutofill="no"\n', '        autoComplete="off"\n', '        secureTextEntry\n', '        spellCheck={false}\n'];
    check(`mutant caught: each of ${props.length} input-hygiene props removed from the passphrase field (source scan)`,
      props.every((p) => gate.includes(p) && !passphraseSources(gate.replace(p, ''), settings, ctx).props));
    check('mutant caught: the passphrase kept in state while it is checked',
      !passphraseSources(gate.replace("    setText('');\n    setBusy(true);", '    setBusy(true);'), settings, ctx).clearedFirst);
    check('mutant caught: the kind read only after the wallet loaded (the lock screen could draw the wrong input first)',
      !passphraseSources(gate, settings, ctx.replace('            if (lockRecord) appLockKind.set(lockRecord.kind);\n', '')).launchKind);
  }
  {
    const m = await mutant('duress.ts', "  return kind === 'phr' ? NOTIFICATIONS_OFF_WITH_PASSPHRASE : NOTIFICATIONS_OFF_WITH_PIN;", '  return NOTIFICATIONS_OFF_WITH_PIN;');
    check('mutant caught (polish): a passphrase lock whose notifications note says PIN', m.notificationsOffWithLock('phr') !== 'Notifications are off while the app passphrase is on: a notification can be read on the lock screen without your passphrase.');
  }
  {
    const m = await mutant('pin.ts', "  return t(kind === 'phr' ? 'lock.phr.checkFailed' : 'lock.pin.checkFailed');", "  return t('lock.pin.checkFailed');");
    check('mutant caught (polish): WalletContext\'s fallback saying PIN for a passphrase lock', m.lockCheckFailedMessage('phr') !== 'The passphrase could not be checked. Try again.');
  }
} finally {
  rmSync(MUTANT_DIR, { recursive: true, force: true });
  seam.setActiveStoreProfile(seam.PRIMARY_STORE_PROFILE);
}

console.log(`\ncheck-duress: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

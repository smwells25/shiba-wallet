/**
 * The app PIN record (duress wallet Stage 2; docs/DURESS_WALLET.md sections
 * 6.2, 6.3 and 7.1). Pure logic over an injected secure-store backend, so
 * scripts/check-duress.mjs drives it under Node with a fake store.
 *
 * WHAT IT IS. An OPT-IN 6-digit PIN typed on the app's own lock screen. It
 * is an app-level gate in front of the wallet: the device's own lock (and,
 * for a protected recovery phrase, its biometric prompt) still guards the
 * secure store, and signing still asks for the device prompt. It reverses
 * the earlier "no app PIN" decision (wallet/lock.ts, threat model T-09)
 * only for users who turn it on.
 *
 * THE RECORD. One secure-store item (STORE_KEYS.appLock), always addressed
 * through a backend bound to the PRIMARY profile: the PIN is checked before
 * any wallet is opened, so the record must not depend on which wallet is
 * active. It ALWAYS holds two slots of the same shape — slot 0 the primary
 * PIN, slot 1 the duress PIN — each a 32-byte salt followed by a 32-byte
 * scrypt hash. A slot with no PIN holds 64 random bytes instead, so the
 * record has exactly the same length and keys whether or not a duress PIN
 * exists (PIN_RECORD_LENGTH, pinned). The wrong-PIN counter and the time
 * until which the next attempt must wait are fixed-width hex in the same
 * record. This hides a duress PIN from someone reading the record's size;
 * it does not hide it from offline guessing (section 3.4) or from the
 * second wallet's own key names (section 3.2).
 *
 * THE KDF. scrypt from @noble/hashes 2.4.0 (scrypt.js; scryptAsync so the
 * JS thread yields while it runs), r = 8, p = 1, dkLen = 32, and
 * N = 2^PIN_SCRYPT_LOG2_N (see that constant for the measurements behind it
 * and why the value is still pending). Every attempt computes BOTH slots'
 * hashes, so an attempt costs about twice one hash. pinScrypt below is the
 * one function that computes it; the Developer-mode measurement
 * (./pin-cost.ts) calls the same function.
 *
 * EVERY ATTEMPT COMPUTES BOTH HASHES and compares each with a constant-time
 * comparison (equalBytesConstantTime below, the same loop as noble-curves'
 * equalBytes, node_modules/@noble/curves/utils.js lines 379–388 in the
 * installed 2.4.0: OR of the XOR of every byte, no early exit), and only
 * then decides primary / duress / wrong, so the work done is the same
 * whichever PIN was typed (section 6.2).
 *
 * THROTTLING (section 6.3). The counter is incremented and written BEFORE
 * the hashes are computed, so killing the app during an attempt still
 * counts it; a correct PIN (either one) resets it. After 5 wrong PINs in a
 * row the next attempt waits 30 seconds, and the wait doubles with every
 * further wrong PIN up to 1 hour (pinWaitSeconds, a pure table). The wait
 * is measured from the END of the failed attempt: it is stamped after both
 * hashes, when the answer is known, because the hashes can take longer
 * than the wait itself (pass p21f measured about 4 minutes per attempt in
 * a debug build, so a wait stamped when the attempt started had always run
 * out before "Wrong PIN" appeared). While a wait runs, an attempt is
 * refused at once and no hash is computed. The wait is stored as an
 * absolute time, so a restart honours it. An attempt killed after its
 * hashes but before the wait is stamped still counts (the counter was
 * written first) but starts no wait; it also showed no answer, so it gave
 * the person at the screen nothing. There is no automatic wipe. Stated
 * limits: this stops guessing at the screen only; restoring an earlier
 * copy of the app's files resets the counter, and offline guessing ignores
 * it.
 *
 * THE PIN ITSELF is never stored, logged or kept: it is passed to scrypt
 * and dropped; callers clear their own copy as soon as the attempt
 * resolves.
 */

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import {
  PRIMARY_STORE_PROFILE,
  STORE_KEYS,
  deleteSecureItem,
  profileBoundSecureBackend,
  readSecureItem,
  writeSecureItem,
  type SecureStoreBackend,
  type SecureStoreItemOptions,
} from './store-keys.ts';

export const PIN_LENGTH = 6;
/**
 * log2 of scrypt's cost parameter N for the app PIN: N = 2^PIN_SCRYPT_LOG2_N.
 * The one place N is set; pinScrypt (below) and the Developer-mode
 * measurement (./pin-cost.ts) both read it, and the record stores N and
 * refuses a record made with another N.
 *
 * MEASUREMENTS SO FAR (both for one hash unless stated):
 *  - Node v24.21.0 on the development machine (Intel Core i7-9750H), the
 *    installed @noble/hashes 2.4.0, 2026-10-14: N = 2^16 took 240–313 ms
 *    (11 runs); N = 2^17 took 479–589 ms, above the 500 ms budget, which is
 *    how 2^16 was chosen.
 *  - The Android emulator, the wallet's own development build with its
 *    DEBUG Hermes bundle, window in front, 2026-10-18 (pass p21f): one
 *    attemptPin (both hashes) took 245–258 s over 9 runs — about 400 times
 *    the Node figure, which makes 2^16 in pure JavaScript unusable there.
 *
 * PENDING: the value is not final. It waits for a measurement in a RELEASE
 * build (Hermes bytecode, no debugger) on the emulator and on a phone,
 * taken with Settings → Developer → "Measure the PIN hashing cost", and
 * then for the Chairperson's decision (a lower N, or a native scrypt).
 * Changing it makes every existing PIN record unreadable (the record
 * stores N), so a change must come with a way to re-create the record.
 */
export const PIN_SCRYPT_LOG2_N = 16;
/** scrypt parameters (N from PIN_SCRYPT_LOG2_N). */
export const PIN_SCRYPT = Object.freeze({ N: 2 ** PIN_SCRYPT_LOG2_N, r: 8, p: 1, dkLen: 32 });
export const PIN_SALT_BYTES = 32;
export const PIN_HASH_BYTES = 32;
/** Wrong PINs allowed in a row before the first wait. */
export const PIN_FREE_ATTEMPTS = 5;
export const PIN_FIRST_WAIT_SECONDS = 30;
export const PIN_MAX_WAIT_SECONDS = 3_600;
export const PIN_FIRST_WAIT_MS = PIN_FIRST_WAIT_SECONDS * 1000;
export const PIN_MAX_WAIT_MS = PIN_MAX_WAIT_SECONDS * 1000;
export const PIN_RECORD_KEY = STORE_KEYS.appLock.name;

export type PinSlot = 'primary' | 'duress';

/** The record as stored. Slots hold salt ‖ hash (or 64 random bytes). */
export interface PinRecord {
  v: 1;
  /** Slot 0 = primary, slot 1 = duress; each 64 bytes. */
  slots: [Uint8Array, Uint8Array];
  /** Wrong PINs in a row (pre-incremented; reset by a correct PIN). */
  fails: number;
  /** Epoch ms before which no attempt is checked (0 = none). */
  until: number;
}

/** What the PIN functions need besides the store (injected by the checks). */
export interface PinDeps {
  /** Cryptographically random bytes (the app: noble randomBytes over crypto.getRandomValues, polyfilled by expo-crypto). */
  random?: (n: number) => Uint8Array;
  now?: () => number;
  /** scrypt(pin, salt) — replaced only by the checks, to count calls or to run faster. */
  kdf?: (pin: string, salt: Uint8Array) => Promise<Uint8Array>;
}

const SLOT_BYTES = PIN_SALT_BYTES + PIN_HASH_BYTES;
const FAILS_HEX = 8;
const UNTIL_HEX = 12;

/** The secure-store options of the record: standard storage, this device only. */
function recordOptions(backend: SecureStoreBackend): SecureStoreItemOptions {
  return { keychainAccessible: backend.whenUnlockedThisDeviceOnly };
}

/** The backend bound to the primary profile: the record never follows the active profile. */
export function pinRecordBackend(backend: SecureStoreBackend): SecureStoreBackend {
  return profileBoundSecureBackend(backend, PRIMARY_STORE_PROFILE);
}

/**
 * The PIN's scrypt: r = 8, p = 1, dkLen = 32 and N = 2^log2N (by default
 * the PIN's own N). The PIN check uses it with no progress callback; the
 * Developer-mode measurement passes other sizes and a progress callback,
 * which noble calls every 1/10,000 of the work and which may throw to stop
 * the hash (noble scrypt.js scryptInit: "onProgress is the only user code
 * that can throw mid-derivation"; the work buffers are wiped first).
 */
export function pinScrypt(
  input: string,
  salt: Uint8Array,
  log2N: number = PIN_SCRYPT_LOG2_N,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const opts = { N: 2 ** log2N, r: PIN_SCRYPT.r, p: PIN_SCRYPT.p, dkLen: PIN_SCRYPT.dkLen };
  return onProgress ? scryptAsync(input, salt, { ...opts, onProgress }) : scryptAsync(input, salt, opts);
}

function defaultKdf(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  return pinScrypt(pin, salt);
}

function deps(d: PinDeps = {}): Required<PinDeps> {
  return {
    random: d.random ?? ((n) => randomBytes(n)),
    now: d.now ?? (() => Date.now()),
    kdf: d.kdf ?? defaultKdf,
  };
}

/**
 * Constant-time equality of two byte arrays of the same length: every byte
 * is visited and the differences are OR-ed together, with no early return
 * (the pattern of noble-curves' equalBytes, cited in the header). Lengths
 * here are fixed (32), so the length test leaks nothing.
 */
export function equalBytesConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Encoding (fixed width: the length never depends on what is set)
// ---------------------------------------------------------------------------

export function encodePinRecord(r: PinRecord): string {
  if (r.slots[0].length !== SLOT_BYTES || r.slots[1].length !== SLOT_BYTES) throw new Error('A PIN slot is 64 bytes.');
  const fails = Math.min(Math.max(0, Math.floor(r.fails)), 0xffffffff);
  const until = Math.min(Math.max(0, Math.floor(r.until)), 2 ** 48 - 1);
  return JSON.stringify({
    v: 1,
    kdf: 'scrypt',
    N: PIN_SCRYPT.N,
    r: PIN_SCRYPT.r,
    p: PIN_SCRYPT.p,
    slots: [bytesToHex(r.slots[0]), bytesToHex(r.slots[1])],
    fails: fails.toString(16).padStart(FAILS_HEX, '0'),
    until: until.toString(16).padStart(UNTIL_HEX, '0'),
  });
}

/** The length of every encoded record (pinned by the check). */
export const PIN_RECORD_LENGTH = encodePinRecord({
  v: 1,
  slots: [new Uint8Array(SLOT_BYTES), new Uint8Array(SLOT_BYTES)],
  fails: 0,
  until: 0,
}).length;

export class PinRecordDamagedError extends Error {
  constructor() {
    super('The app PIN record on this phone could not be read.');
    this.name = 'PinRecordDamagedError';
  }
}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);

export function decodePinRecord(raw: string): PinRecord {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new PinRecordDamagedError();
  }
  const p = o as Record<string, unknown>;
  const keys = p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p).sort().join(',') : '';
  if (
    raw.length !== PIN_RECORD_LENGTH ||
    keys !== 'N,fails,kdf,p,r,slots,until,v' ||
    p.v !== 1 ||
    p.kdf !== 'scrypt' ||
    p.N !== PIN_SCRYPT.N ||
    p.r !== PIN_SCRYPT.r ||
    p.p !== PIN_SCRYPT.p ||
    !Array.isArray(p.slots) ||
    p.slots.length !== 2 ||
    !p.slots.every((s) => typeof s === 'string' && HEX(SLOT_BYTES * 2).test(s)) ||
    typeof p.fails !== 'string' ||
    !HEX(FAILS_HEX).test(p.fails) ||
    typeof p.until !== 'string' ||
    !HEX(UNTIL_HEX).test(p.until)
  ) {
    throw new PinRecordDamagedError();
  }
  const slots = p.slots as string[];
  return {
    v: 1,
    slots: [hexToBytes(slots[0]), hexToBytes(slots[1])],
    fails: parseInt(p.fails, 16),
    until: parseInt(p.until, 16),
  };
}

// ---------------------------------------------------------------------------
// Store access (always the primary profile's name)
// ---------------------------------------------------------------------------

/** The record, or null when no app PIN is set. Throws PinRecordDamagedError. */
export async function readPinRecord(backend: SecureStoreBackend): Promise<PinRecord | null> {
  const b = pinRecordBackend(backend);
  const raw = await readSecureItem(b, PIN_RECORD_KEY, recordOptions(b));
  return raw === null ? null : decodePinRecord(raw);
}

export async function writePinRecord(backend: SecureStoreBackend, record: PinRecord): Promise<void> {
  const b = pinRecordBackend(backend);
  await writeSecureItem(b, PIN_RECORD_KEY, encodePinRecord(record), recordOptions(b));
}

export async function deletePinRecord(backend: SecureStoreBackend): Promise<void> {
  const b = pinRecordBackend(backend);
  await deleteSecureItem(b, PIN_RECORD_KEY, recordOptions(b));
}

// ---------------------------------------------------------------------------
// PIN rules
// ---------------------------------------------------------------------------

export const PIN_FORMAT_MESSAGE = 'A PIN is exactly 6 digits.';
/**
 * One sentence for every PIN that is refused as a NEW PIN (too easy to
 * guess, or equal to the other slot's PIN): the same words whichever
 * reason, so a change made under the second wallet cannot be used to learn
 * the first wallet's PIN from a different message.
 */
export const PIN_NOT_USABLE_MESSAGE = 'This PIN cannot be used. Choose a different 6-digit PIN.';
export const PIN_MISMATCH_MESSAGE = 'The two PINs you typed are different. Nothing was changed.';
export const PIN_DAMAGED_MESSAGE =
  'The app PIN record on this phone could not be read, so no PIN can be checked. Your recovery phrase restores the wallet on a fresh install.';

/** null when `pin` has the right form (exactly 6 ASCII digits). */
export function pinFormatError(pin: string): string | null {
  return /^[0-9]{6}$/.test(pin) ? null : PIN_FORMAT_MESSAGE;
}

/** All one digit, 123456 or its reverse (docs/DURESS_WALLET.md section 6.2). */
export function isTriviallyGuessed(pin: string): boolean {
  return /^(\d)\1{5}$/.test(pin) || pin === '123456' || pin === '654321';
}

/**
 * The wait schedule as a pure function: wrong PINs in a row → seconds to
 * wait before the next attempt. 0 for 0–4, then 30 s, doubling with every
 * further wrong PIN, capped at 1 hour (pinned by table in check-duress).
 */
export function pinWaitSeconds(fails: number): number {
  if (!Number.isFinite(fails)) return PIN_MAX_WAIT_SECONDS;
  if (fails < PIN_FREE_ATTEMPTS) return 0;
  const doublings = Math.floor(fails) - PIN_FREE_ATTEMPTS;
  if (doublings >= 7) return PIN_MAX_WAIT_SECONDS;
  return Math.min(PIN_MAX_WAIT_SECONDS, PIN_FIRST_WAIT_SECONDS * 2 ** doublings);
}

/** The same schedule in milliseconds. */
export function waitAfterFailures(fails: number): number {
  return pinWaitSeconds(fails) * 1000;
}

/** "Try again in N seconds." / "… N minutes." for a wait ending at `until`. */
export function tryAgainSentence(until: number, now: number): string {
  const s = Math.max(1, Math.ceil((until - now) / 1000));
  if (s < 120) return `Try again in ${s} second${s === 1 ? '' : 's'}.`;
  const m = Math.ceil(s / 60);
  return `Try again in ${m} minutes.`;
}

async function slotFor(pin: string, d: Required<PinDeps>): Promise<Uint8Array> {
  const salt = d.random(PIN_SALT_BYTES);
  if (salt.length !== PIN_SALT_BYTES) throw new Error('The random source returned the wrong length.');
  const hash = await d.kdf(pin, salt);
  const out = new Uint8Array(SLOT_BYTES);
  out.set(salt, 0);
  out.set(hash, PIN_SALT_BYTES);
  return out;
}

function randomSlot(d: Required<PinDeps>): Uint8Array {
  const r = d.random(SLOT_BYTES);
  if (r.length !== SLOT_BYTES) throw new Error('The random source returned the wrong length.');
  return Uint8Array.from(r);
}

/** Both slots' hashes for `pin`, always both, then the two constant-time comparisons. */
export async function matchSlots(record: PinRecord, pin: string, d: PinDeps = {}): Promise<{ primary: boolean; duress: boolean }> {
  const dd = deps(d);
  const h0 = await dd.kdf(pin, record.slots[0].subarray(0, PIN_SALT_BYTES));
  const h1 = await dd.kdf(pin, record.slots[1].subarray(0, PIN_SALT_BYTES));
  const primary = equalBytesConstantTime(h0, record.slots[0].subarray(PIN_SALT_BYTES));
  const duress = equalBytesConstantTime(h1, record.slots[1].subarray(PIN_SALT_BYTES));
  h0.fill(0);
  h1.fill(0);
  return { primary, duress };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type PinAttemptOutcome =
  | { kind: 'opened'; slot: PinSlot }
  | { kind: 'wrong'; fails: number; until: number }
  | { kind: 'wait'; until: number }
  | { kind: 'no-pin' };

/**
 * One PIN attempt (the lock screen, and the current-PIN step of every
 * Settings change). Reads the record; refuses while a wait runs (nothing is
 * computed); otherwise writes the incremented counter and its wait FIRST,
 * computes both slots' hashes, and resets the counter on a match. If the
 * PIN matched both slots (impossible: setPinSlot refuses a PIN equal to the
 * other slot) the primary wins, so a duress PIN can never open the real
 * wallet by this rule. With `expect`, only that slot's PIN counts.
 */
export async function attemptPin(
  backend: SecureStoreBackend,
  pin: string,
  d: PinDeps = {},
  expect?: PinSlot,
): Promise<PinAttemptOutcome> {
  const dd = deps(d);
  const record = await readPinRecord(backend);
  if (!record) return { kind: 'no-pin' };
  // While a wait runs: refused at once, nothing written, no hash computed.
  if (record.until > dd.now()) return { kind: 'wait', until: record.until };
  const fails = record.fails + 1;
  // The counter goes in BEFORE the hashes (section 6.3); the wait does not:
  // it is stamped below, once this attempt has failed.
  await writePinRecord(backend, { ...record, fails, until: 0 });
  // A malformed PIN still costs both hashes (no shortcut that answers faster).
  const m = await matchSlots(record, pin, dd);
  const slot: PinSlot | null = pinFormatError(pin) !== null ? null : m.primary ? 'primary' : m.duress ? 'duress' : null;
  // `expect` (Settings: "type your current PIN"): only the PIN of the wallet
  // that is open counts. The other slot's PIN is treated as a wrong PIN and
  // does NOT reset the counter, so the wait schedule cannot reveal that a
  // guess typed into a Settings field was the other wallet's PIN.
  if (slot !== null && (expect === undefined || slot === expect)) {
    await writePinRecord(backend, { ...record, fails: 0, until: 0 });
    return { kind: 'opened', slot };
  }
  // Wrong: the wait runs from NOW, the end of this attempt, so it is still
  // ahead when the answer is shown however long the two hashes took.
  const wait = waitAfterFailures(fails);
  const until = wait > 0 ? dd.now() + wait : 0;
  await writePinRecord(backend, { ...record, fails, until });
  return { kind: 'wrong', fails, until };
}

/** A new record with the primary PIN set and the duress slot random. */
export async function createPinRecord(pin: string, d: PinDeps = {}): Promise<PinRecord> {
  const dd = deps(d);
  if (pinFormatError(pin)) throw new Error(PIN_FORMAT_MESSAGE);
  if (isTriviallyGuessed(pin)) throw new Error(PIN_NOT_USABLE_MESSAGE);
  return { v: 1, slots: [await slotFor(pin, dd), randomSlot(dd)], fails: 0, until: 0 };
}

/** Turns the app PIN on: refuses when a record already exists (no overwrite). */
export async function setAppPin(backend: SecureStoreBackend, pin: string, d: PinDeps = {}): Promise<void> {
  if (await readPinRecord(backend)) throw new Error('An app PIN is already set. Nothing was changed.');
  await writePinRecord(backend, await createPinRecord(pin, d));
}

/**
 * Sets `slot` to `newPin` (the caller has just verified the current PIN of
 * the session with attemptPin). The new PIN must have the right form, must
 * not be trivially guessed and must not open the OTHER slot — that check
 * computes the other slot's hash every time, and its refusal is the same
 * sentence as a trivially guessed PIN's.
 */
export async function setPinSlot(backend: SecureStoreBackend, slot: PinSlot, newPin: string, d: PinDeps = {}): Promise<void> {
  const dd = deps(d);
  const record = await readPinRecord(backend);
  if (!record) throw new Error('No app PIN is set. Nothing was changed.');
  if (pinFormatError(newPin)) throw new Error(PIN_FORMAT_MESSAGE);
  const m = await matchSlots(record, newPin, dd);
  const collides = slot === 'primary' ? m.duress : m.primary;
  if (isTriviallyGuessed(newPin) || collides) throw new Error(PIN_NOT_USABLE_MESSAGE);
  const slots: [Uint8Array, Uint8Array] = [record.slots[0], record.slots[1]];
  slots[slot === 'primary' ? 0 : 1] = await slotFor(newPin, dd);
  await writePinRecord(backend, { ...record, slots });
}

/** Returns the duress slot to random bytes (the record keeps its shape). */
export async function clearDuressSlot(backend: SecureStoreBackend, d: PinDeps = {}): Promise<void> {
  const dd = deps(d);
  const record = await readPinRecord(backend);
  if (!record) return;
  await writePinRecord(backend, { ...record, slots: [record.slots[0], randomSlot(dd)] });
}

/** Shown on the pad when a wait it was counting down has run out. */
export const PIN_WAIT_OVER_MESSAGE = 'You can enter your PIN again.';

/** The lock screen's sentence for an attempt's outcome (the same whichever wallet a PIN would open). */
export function pinAttemptMessage(outcome: PinAttemptOutcome, now: number): string | null {
  if (outcome.kind === 'wrong') return outcome.until > now ? `Wrong PIN. ${tryAgainSentence(outcome.until, now)}` : 'Wrong PIN. Try again.';
  if (outcome.kind === 'wait') return outcome.until > now ? `Too many wrong PINs. ${tryAgainSentence(outcome.until, now)}` : PIN_WAIT_OVER_MESSAGE;
  if (outcome.kind === 'no-pin') return 'No app PIN is set on this phone.';
  return null;
}

/**
 * A wait the PinPad counts down: the kind of answer that started it and the
 * stamped time it ends. The pad re-reads pinCountdownText every second from
 * this stamped time, so the figure shown always matches the record.
 */
export interface PinCountdown {
  kind: 'wrong' | 'wait';
  until: number;
}

/** The countdown an outcome starts, or null when it starts none. */
export function pinCountdownOf(outcome: PinAttemptOutcome): PinCountdown | null {
  if (outcome.kind === 'wait') return { kind: 'wait', until: outcome.until };
  if (outcome.kind === 'wrong' && outcome.until > 0) return { kind: 'wrong', until: outcome.until };
  return null;
}

/** The pad's line for a countdown at `now` ("… Try again in 29 seconds.", then the wait-over sentence). */
export function pinCountdownText(c: PinCountdown, now: number): string {
  const outcome: PinAttemptOutcome = c.kind === 'wait' ? { kind: 'wait', until: c.until } : { kind: 'wrong', fails: PIN_FREE_ATTEMPTS, until: c.until };
  return pinAttemptMessage(outcome, now) ?? '';
}

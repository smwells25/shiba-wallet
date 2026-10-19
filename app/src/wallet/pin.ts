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
 * THE KDF. scrypt with r = 8, p = 1, dkLen = 32 and N = 2^PIN_SCRYPT_LOG2_N
 * (see that constant for the measurements behind it). pinScrypt below is the
 * one function that computes it, by one of two paths that give the same
 * bytes: the NATIVE scrypt of react-native-quick-crypto (OpenSSL's
 * EVP_PBE_scrypt on a background thread; ./pin-native-scrypt.ts says how it
 * is found, self-checked against RFC 7914 and given its maxmem) wherever the
 * app binary carries it, else the JavaScript scrypt of @noble/hashes 2.4.0
 * (scrypt.js; scryptAsync so the JS thread yields while it runs), which is
 * what Expo Go and the check scripts use. The record format does not depend
 * on the path: a PIN set through one path opens through the other. Every
 * attempt computes BOTH slots' hashes, so an attempt costs about twice one
 * hash. The Developer-mode measurement (./pin-cost.ts) calls the same
 * function.
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
 *
 * A PASSPHRASE INSTEAD OF THE PIN (docs/DURESS_WALLET.md section 8.2, stage
 * P1; the Chairperson's decision of 2026-10-19). The lock's KIND is "pin"
 * (6 digits on the app-drawn pad) or "phr" (a passphrase typed in a secure
 * text field). The kind belongs to the whole lock — both slots are the same
 * kind (section 8.2.6) — and is stored as one 3-character field of the
 * record, version 2, which the lock screen reads before any wallet is
 * chosen, so it can draw the pad or the field. Everything else is the same
 * for both kinds: the two fixed-size slots, both hashes on every attempt,
 * the counter written first, the wait schedule. A passphrase is hashed as
 * its canonical form (lockSecretInput: edge whitespace stripped, then NFKD
 * with the same rule as @scure/bip39) through the same pinScrypt, so its
 * length is neither stored nor visible in the record or the cost. A version
 * 1 record (written before passphrases existed) reads as kind "pin" and is
 * rewritten as version 2 by the next write (the counter write of the next
 * attempt), with the same slots, so an existing PIN opens unchanged.
 */

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { nativeScryptForPin, noteNativeScryptFailure, pinScryptMaxmem } from './pin-native-scrypt.ts';
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
import { t, type StringId } from '../i18n/index.ts';

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
 *  - The same emulator, the RELEASE build (Hermes bytecode, no debugger),
 *    2026-10-18 (pass p21g), JavaScript scrypt: one hash at 2^16 took 49–53 s
 *    over three runs, so an unlock took about 100 s.
 *
 * DECIDED (the Chairperson, 2026-10-19): N stays 2^16 and the hash moves to
 * the native scrypt of react-native-quick-crypto behind pinScrypt (threat
 * model F-81). The native path has not been measured on a device yet; Expo
 * Go, which cannot carry it, keeps the JavaScript scrypt and its cost.
 * Changing N makes every existing PIN record unreadable (the record
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

/**
 * The kind of the app lock (docs/DURESS_WALLET.md section 8.2.5): "pin" (6
 * digits) or "phr" (a passphrase). Three characters either way, so the
 * record's length does not depend on it; it describes BOTH slots.
 */
export type LockKind = 'pin' | 'phr';
export const LOCK_KINDS: readonly LockKind[] = Object.freeze(['pin', 'phr']);

/** The record as stored. Slots hold salt ‖ hash (or 64 random bytes). */
export interface PinRecord {
  /** The version read (1 or 2); every write writes version 2. */
  v: 1 | 2;
  /** The kind of BOTH slots (a version 1 record reads as "pin"). */
  kind: LockKind;
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
 * Developer-mode measurement passes other sizes and a progress callback.
 *
 * THE NATIVE PATH (./pin-native-scrypt.ts), when this session has one that
 * passed its self-check: the input as UTF-8 bytes (what noble does with a
 * string), the same salt and parameters, and maxmem = 128·r·N + 1 MiB. It
 * cannot be interrupted inside one hash, so the progress callback is NOT
 * called on this path (the measurement stops between sizes instead). If the
 * native call fails, the rest of the session uses the JavaScript path and
 * this hash is computed there; the result is the same bytes either way.
 *
 * THE JAVASCRIPT PATH: noble's scryptAsync. The progress callback is called
 * every 1/10,000 of the work and may throw to stop the hash (noble
 * scrypt.js scryptInit: "onProgress is the only user code that can throw
 * mid-derivation"; the work buffers are wiped first).
 */
export async function pinScrypt(
  input: string,
  salt: Uint8Array,
  log2N: number = PIN_SCRYPT_LOG2_N,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const opts = { N: 2 ** log2N, r: PIN_SCRYPT.r, p: PIN_SCRYPT.p, dkLen: PIN_SCRYPT.dkLen };
  const native = await nativeScryptForPin();
  if (native) {
    try {
      const out = await native(utf8ToBytes(input), salt, opts.N, opts.r, opts.p, pinScryptMaxmem(opts.N, opts.r), opts.dkLen);
      if (out.length !== opts.dkLen) throw new Error(`The native scrypt returned ${out.length} bytes instead of ${opts.dkLen}.`);
      return out;
    } catch (e) {
      noteNativeScryptFailure(e);
    }
  }
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

/**
 * The record's JSON text. Version 2 (every write) carries `kind`; version 1
 * is produced only to know its fixed length (PIN_RECORD_LENGTH_V1), which
 * the decoder accepts. Every field has a fixed width, so the length is one
 * constant per version whatever the record holds.
 */
function encodeRecordText(r: PinRecord, version: 1 | 2): string {
  if (r.slots[0].length !== SLOT_BYTES || r.slots[1].length !== SLOT_BYTES) throw new Error('A PIN slot is 64 bytes.');
  if (!LOCK_KINDS.includes(r.kind)) throw new Error('The lock kind is "pin" or "phr".');
  const fails = Math.min(Math.max(0, Math.floor(r.fails)), 0xffffffff);
  const until = Math.min(Math.max(0, Math.floor(r.until)), 2 ** 48 - 1);
  return JSON.stringify({
    v: version,
    kdf: 'scrypt',
    N: PIN_SCRYPT.N,
    r: PIN_SCRYPT.r,
    p: PIN_SCRYPT.p,
    ...(version === 2 ? { kind: r.kind } : {}),
    slots: [bytesToHex(r.slots[0]), bytesToHex(r.slots[1])],
    fails: fails.toString(16).padStart(FAILS_HEX, '0'),
    until: until.toString(16).padStart(UNTIL_HEX, '0'),
  });
}

/** The stored text of a record: always version 2. */
export function encodePinRecord(r: PinRecord): string {
  return encodeRecordText(r, 2);
}

const EMPTY_RECORD: PinRecord = { v: 2, kind: 'pin', slots: [new Uint8Array(SLOT_BYTES), new Uint8Array(SLOT_BYTES)], fails: 0, until: 0 };
/**
 * The length of every encoded record, version 2 (pinned by the check):
 * 371 characters for either kind — the 358 of version 1 plus the 13 of
 * `,"kind":"pin"` / `,"kind":"phr"`.
 */
export const PIN_RECORD_LENGTH = encodePinRecord(EMPTY_RECORD).length;
/** The length of a version 1 record (358), still accepted by the decoder. */
export const PIN_RECORD_LENGTH_V1 = encodeRecordText(EMPTY_RECORD, 1).length;

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
  // Version 1 (no kind: a PIN) or version 2 (with a kind), each at its own
  // exact length and key set; a version 1 record with a kind, a version 2
  // record without one, or an unknown kind is damaged.
  const v1 = p?.v === 1 && raw.length === PIN_RECORD_LENGTH_V1 && keys === 'N,fails,kdf,p,r,slots,until,v';
  const v2 =
    p?.v === 2 && raw.length === PIN_RECORD_LENGTH && keys === 'N,fails,kdf,kind,p,r,slots,until,v' && LOCK_KINDS.includes(p.kind as LockKind);
  if (
    !(v1 || v2) ||
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
    v: v2 ? 2 : 1,
    kind: v2 ? (p.kind as LockKind) : 'pin',
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

/**
 * The lock's kind, or null when no app lock is set: ONE read of the record
 * (the primary profile's name), nothing of either wallet. The lock screen
 * needs it before any wallet is chosen. Throws PinRecordDamagedError.
 */
export async function readLockKind(backend: SecureStoreBackend): Promise<LockKind | null> {
  const record = await readPinRecord(backend);
  return record ? record.kind : null;
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

// ---------------------------------------------------------------------------
// Passphrase rules (docs/DURESS_WALLET.md sections 8.2.2–8.2.4)
// ---------------------------------------------------------------------------

/** NIST SP 800-63B-4's single-factor floor (section 8.2.2), in Unicode code points as typed. */
export const PASSPHRASE_MIN_CODE_POINTS = 15;
/** The ceiling (section 8.2.2): NIST asks for at least 64; 128 matches the newer Trezor models. */
export const PASSPHRASE_MAX_CODE_POINTS = 128;
/** Recovery-phrase words a new passphrase may contain (three or more are refused; a judgement, section 8.5 question 8). */
export const PASSPHRASE_MAX_PHRASE_WORDS = 2;
/** Near-copy thresholds for a duress passphrase (section 8.2.4 rule 7; judgements). */
export const PASSPHRASE_NEAR_EDITS = 4;
export const PASSPHRASE_NEAR_SHARED_RUN = 8;

export const PASSPHRASE_LENGTH_MESSAGE = 'A passphrase has 15 to 128 characters.';
export const PASSPHRASE_EDGE_SPACE_MESSAGE = 'A passphrase cannot begin or end with a space.';
export const PASSPHRASE_CONTROL_MESSAGE = 'A passphrase cannot contain line breaks or other control characters.';
/** Ill-formed Unicode (an unpaired UTF-16 surrogate): no keyboard types one, but a paste could. */
export const PASSPHRASE_INVALID_TEXT_MESSAGE = 'This passphrase contains a character that is not valid text. Type it again.';
export const PASSPHRASE_PHRASE_WORDS_MESSAGE = 'Do not use words from your recovery phrase in your passphrase.';
/**
 * One sentence for every passphrase refused for a reason that could say
 * something about the OTHER slot or about how close a guess is (one
 * repeated character, equal to the other slot, a near copy of the app
 * passphrase): the same words whichever reason (section 8.2.4).
 */
export const PASSPHRASE_NOT_USABLE_MESSAGE = 'This passphrase cannot be used. Choose a different passphrase.';
export const PASSPHRASE_MISMATCH_MESSAGE = 'The two passphrases you typed are different. Nothing was changed.';

/**
 * Whether a string is well-formed Unicode (no unpaired UTF-16 surrogate):
 * the same loop as @scure/bip39 2.4.0's private isWellFormedUnicode
 * (node_modules/@scure/bip39/index.js lines 11–26), which its nfkd (lines
 * 33–39) calls before normalising. The library does not EXPORT nfkd (its
 * index.d.ts lists only the mnemonic functions), so the rule is mirrored
 * here and pinned by check-duress against the library's own behaviour:
 * mnemonicToSeedSync(m, p) equals mnemonicToSeedSync(m, bip39Nfkd(p)) and
 * throws exactly where this refuses.
 */
function isWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const current = value.charCodeAt(i);
    if (current >= 0xd800 && current <= 0xdbff) {
      if (i + 1 >= value.length) return false;
      const next = value.charCodeAt(++i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * BIP-39's normalisation of a passphrase, as @scure/bip39 2.4.0 applies it
 * (index.js nfkd, lines 33–39: refuse ill-formed Unicode, then
 * String.prototype.normalize('NFKD')). Throws for ill-formed input.
 */
export function bip39Nfkd(text: string): string {
  if (!isWellFormedUnicode(text)) throw new TypeError('expected well-formed Unicode string');
  return text.normalize('NFKD');
}

/** The number of Unicode code points (an emoji is one; "e" + a combining accent is two). */
export function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Whether the text holds a character of Unicode's general category Cc: the
 * 65 control characters U+0000–U+001F and U+007F–U+009F, line breaks and
 * tabs included. Written as code-unit ranges rather than a Unicode property
 * escape so it does not depend on the JavaScript engine's support for
 * those escapes (Hermes on a device was not checked for it); check-duress
 * pins it equal to Node's category test over every BMP code point (all Cc
 * characters are in the BMP, and no surrogate falls in these ranges).
 */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * The string that is hashed for what was typed (section 8.2.5): a PIN as
 * typed (six ASCII digits are their own NFKD form, so a PIN set before
 * passphrases existed hashes exactly as before); a passphrase with its edge
 * whitespace stripped (String.prototype.trim: the same whitespace set as the
 * set-up refusal's \s) and then normalised to NFKD. Ill-formed input is
 * returned stripped but not normalised; it never matches a slot, because no
 * stored passphrase is ill-formed (lockEntryWellFormed refuses it first).
 */
export function lockSecretInput(kind: LockKind, typed: string): string {
  if (kind === 'pin') return typed;
  const stripped = typed.trim();
  return isWellFormedUnicode(stripped) ? stripped.normalize('NFKD') : stripped;
}

/**
 * Whether an entry at the lock screen (or a "current secret" field) has the
 * kind's form: 6 digits, or — after the edge strip — a well-formed
 * passphrase of 15 to 128 code points with no control character. A
 * malformed entry still costs both hashes and counts (attemptPin), so the
 * lock screen never answers a format error faster and never states the
 * minimum length.
 */
export function lockEntryWellFormed(kind: LockKind, typed: string): boolean {
  if (kind === 'pin') return pinFormatError(typed) === null;
  const stripped = typed.trim();
  const n = codePointLength(stripped);
  return isWellFormedUnicode(stripped) && !hasControlCharacter(stripped) && n >= PASSPHRASE_MIN_CODE_POINTS && n <= PASSPHRASE_MAX_CODE_POINTS;
}

/**
 * The form of a NEW passphrase (section 8.2.4 rules 1–3), or null: its
 * length in code points as typed, no edge whitespace (refused at set-up, so
 * that stripping at entry can never turn a stored passphrase into a wrong
 * one), no control character, well-formed Unicode. These reveal nothing
 * about the other slot, so each says exactly what is wrong.
 */
export function passphraseFormatError(typed: string): string | null {
  const n = codePointLength(typed);
  if (n < PASSPHRASE_MIN_CODE_POINTS || n > PASSPHRASE_MAX_CODE_POINTS) return PASSPHRASE_LENGTH_MESSAGE;
  if (/^\s|\s$/.test(typed)) return PASSPHRASE_EDGE_SPACE_MESSAGE;
  if (!isWellFormedUnicode(typed)) return PASSPHRASE_INVALID_TEXT_MESSAGE;
  if (hasControlCharacter(typed)) return PASSPHRASE_CONTROL_MESSAGE;
  return null;
}

/** The form of a new secret of `kind`, or null. */
export function newLockSecretFormatError(kind: LockKind, typed: string): string | null {
  return kind === 'pin' ? pinFormatError(typed) : passphraseFormatError(typed);
}

/** Rule 4: the passphrase is one character repeated (after NFKD). */
export function isOneRepeatedCharacter(canonical: string): boolean {
  return new Set([...canonical]).size <= 1;
}

/**
 * Rule 5: how many DISTINCT words of the recovery phrase the passphrase
 * contains as whitespace-separated words, compared after lower-casing. A
 * word typed twice counts once: it gives a guesser one word, not two.
 */
export function recoveryWordsIn(canonical: string, phrase: string): number {
  const words = new Set(phrase.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0));
  const found = new Set<string>();
  for (const token of canonical.toLowerCase().split(/\s+/)) if (words.has(token)) found.add(token);
  return found.size;
}

/** Levenshtein distance over code points (inputs are at most 128 code points). */
function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The longest run of code points the two strings share. */
function longestSharedRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * Rule 7 (a duress passphrase against the app passphrase, both typed in the
 * same flow): after NFKD, edge strip and lower-casing, one contains the
 * other, or they differ by 4 or fewer single-character edits, or they share
 * a run of 8 or more characters. Equality is the first case.
 */
export function isNearCopy(a: string, b: string): boolean {
  const x = [...lockSecretInput('phr', a).toLowerCase()];
  const y = [...lockSecretInput('phr', b).toLowerCase()];
  const xs = x.join('');
  const ys = y.join('');
  if (xs.includes(ys) || ys.includes(xs)) return true;
  if (editDistance(x, y) <= PASSPHRASE_NEAR_EDITS) return true;
  return longestSharedRun(x, y) >= PASSPHRASE_NEAR_SHARED_RUN;
}

/** The refusal sentence of `kind` for a new secret that cannot be used (the shared one). */
export function notUsableMessage(kind: LockKind): string {
  return kind === 'pin' ? PIN_NOT_USABLE_MESSAGE : PASSPHRASE_NOT_USABLE_MESSAGE;
}

/** The sentence for two typings of a new secret that differ. */
export function mismatchMessage(kind: LockKind): string {
  return kind === 'pin' ? PIN_MISMATCH_MESSAGE : PASSPHRASE_MISMATCH_MESSAGE;
}

/** Whether two typings are the same secret of `kind` (compared in their canonical form). */
export function sameLockSecret(kind: LockKind, a: string, b: string): boolean {
  return lockSecretInput(kind, a) === lockSecretInput(kind, b);
}

/**
 * Every plaintext rule for a NEW secret of `kind` (Settings checks it as
 * soon as the secret is typed; setPinSlot / setLockSlots repeat the rules
 * that need no phrase and add the hash comparison with the other slot):
 *  - PIN: 6 digits; not trivially guessed (the shared sentence);
 *  - passphrase: rules 1–3 (their own sentences); rule 4, one repeated
 *    character (the shared sentence); rule 5, three or more words of
 *    `phrase` — the OPEN wallet's recovery phrase, which the flow opened
 *    through the approval gate — (its own sentence); rule 7, for a duress
 *    passphrase given the app passphrase typed in the same flow, a near
 *    copy (the shared sentence).
 * The phrase and the other passphrase are only compared, never kept.
 */
export function newLockSecretRefusal(
  kind: LockKind,
  typed: string,
  context: { phrase?: string | null; appSecret?: string | null } = {},
): string | null {
  const form = newLockSecretFormatError(kind, typed);
  if (form) return form;
  if (kind === 'pin') return isTriviallyGuessed(typed) ? PIN_NOT_USABLE_MESSAGE : null;
  const canonical = lockSecretInput('phr', typed);
  if (isOneRepeatedCharacter(canonical)) return PASSPHRASE_NOT_USABLE_MESSAGE;
  if (context.phrase && recoveryWordsIn(canonical, context.phrase) > PASSPHRASE_MAX_PHRASE_WORDS) return PASSPHRASE_PHRASE_WORDS_MESSAGE;
  if (context.appSecret && isNearCopy(context.appSecret, typed)) return PASSPHRASE_NOT_USABLE_MESSAGE;
  return null;
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
  // Through the string table (phase 22 item 6); English unchanged.
  if (s < 120) return s === 1 ? t('lock.tryAgain.second') : t('lock.tryAgain.seconds', { count: s });
  const m = Math.ceil(s / 60);
  return t('lock.tryAgain.minutes', { count: m });
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

/** An attempt's outcome; `lock` is the record's kind, so the sentence can name a PIN or a passphrase. */
export type PinAttemptOutcome =
  | { kind: 'opened'; slot: PinSlot; lock?: LockKind }
  | { kind: 'wrong'; fails: number; until: number; lock?: LockKind }
  | { kind: 'wait'; until: number; lock?: LockKind }
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
  const lock = record.kind;
  // While a wait runs: refused at once, nothing written, no hash computed.
  if (record.until > dd.now()) return { kind: 'wait', until: record.until, lock };
  const fails = record.fails + 1;
  // The counter goes in BEFORE the hashes (section 6.3); the wait does not:
  // it is stamped below, once this attempt has failed. (This write also
  // converts a version 1 record to version 2.)
  await writePinRecord(backend, { ...record, fails, until: 0 });
  // A malformed PIN or passphrase still costs both hashes (no shortcut that
  // answers faster); both hashes are of the same canonical input.
  const input = lockSecretInput(lock, pin);
  const m = await matchSlots(record, input, dd);
  const slot: PinSlot | null = !lockEntryWellFormed(lock, pin) ? null : m.primary ? 'primary' : m.duress ? 'duress' : null;
  // `expect` (Settings: "type your current PIN"): only the PIN of the wallet
  // that is open counts. The other slot's PIN is treated as a wrong PIN and
  // does NOT reset the counter, so the wait schedule cannot reveal that a
  // guess typed into a Settings field was the other wallet's PIN.
  if (slot !== null && (expect === undefined || slot === expect)) {
    await writePinRecord(backend, { ...record, fails: 0, until: 0 });
    return { kind: 'opened', slot, lock };
  }
  // Wrong: the wait runs from NOW, the end of this attempt, so it is still
  // ahead when the answer is shown however long the two hashes took.
  const wait = waitAfterFailures(fails);
  const until = wait > 0 ? dd.now() + wait : 0;
  await writePinRecord(backend, { ...record, fails, until });
  return { kind: 'wrong', fails, until, lock };
}

/**
 * The rules a new secret must pass without the recovery phrase (the form,
 * then the shared refusals): what setters repeat whatever Settings checked.
 */
function assertNewSecret(kind: LockKind, secret: string): void {
  const form = newLockSecretFormatError(kind, secret);
  if (form) throw new Error(form);
  const refusal = newLockSecretRefusal(kind, secret);
  if (refusal) throw new Error(refusal);
}

/** A new record of `kind` (a PIN unless stated) with the primary slot set and the duress slot random. */
export async function createPinRecord(pin: string, d: PinDeps = {}, kind: LockKind = 'pin'): Promise<PinRecord> {
  const dd = deps(d);
  assertNewSecret(kind, pin);
  return { v: 2, kind, slots: [await slotFor(lockSecretInput(kind, pin), dd), randomSlot(dd)], fails: 0, until: 0 };
}

/** Turns the app lock on (a PIN unless stated): refuses when a record already exists (no overwrite). */
export async function setAppPin(backend: SecureStoreBackend, pin: string, d: PinDeps = {}, kind: LockKind = 'pin'): Promise<void> {
  if (await readPinRecord(backend)) throw new Error('An app PIN or passphrase is already set. Nothing was changed.');
  await writePinRecord(backend, await createPinRecord(pin, d, kind));
}

/**
 * Sets `slot` to `newPin` (the caller has just verified the current secret
 * of the session with attemptPin). The new secret has the RECORD's kind
 * (both slots are always the same kind, section 8.2.6): it must have that
 * kind's form, pass its plaintext rules and must not open the OTHER slot —
 * that check computes the other slot's hash every time, and its refusal is
 * the kind's shared sentence.
 */
export async function setPinSlot(backend: SecureStoreBackend, slot: PinSlot, newPin: string, d: PinDeps = {}): Promise<void> {
  const dd = deps(d);
  const record = await readPinRecord(backend);
  if (!record) throw new Error('No app PIN or passphrase is set. Nothing was changed.');
  const kind = record.kind;
  const form = newLockSecretFormatError(kind, newPin);
  if (form) throw new Error(form);
  const input = lockSecretInput(kind, newPin);
  const m = await matchSlots(record, input, dd);
  const collides = slot === 'primary' ? m.duress : m.primary;
  if (newLockSecretRefusal(kind, newPin) !== null || collides) throw new Error(notUsableMessage(kind));
  const slots: [Uint8Array, Uint8Array] = [record.slots[0], record.slots[1]];
  slots[slot === 'primary' ? 0 : 1] = await slotFor(input, dd);
  await writePinRecord(backend, { ...record, slots });
}

/**
 * Switches the lock to `kind` (section 8.2.7): BOTH slots rewritten in ONE
 * record write, so the record never holds two kinds, not even after a
 * crash. The caller verified the current secret of the REAL wallet and
 * passes the new app secret and — when a duress secret exists — the new
 * duress secret, both of the new kind (null leaves the duress slot random,
 * which deletes nothing but means no duress secret). The two must not be
 * the same secret (a near copy, for passphrases); the refusal is the
 * kind's shared sentence. The counter is kept as it is (the current secret
 * just reset it).
 */
export async function setLockSlots(
  backend: SecureStoreBackend,
  kind: LockKind,
  appSecret: string,
  duressSecret: string | null,
  d: PinDeps = {},
): Promise<void> {
  const dd = deps(d);
  if (!LOCK_KINDS.includes(kind)) throw new Error('The lock kind is "pin" or "phr".');
  const record = await readPinRecord(backend);
  if (!record) throw new Error('No app PIN or passphrase is set. Nothing was changed.');
  assertNewSecret(kind, appSecret);
  if (duressSecret !== null) {
    assertNewSecret(kind, duressSecret);
    const same = kind === 'pin' ? sameLockSecret('pin', appSecret, duressSecret) : isNearCopy(appSecret, duressSecret);
    if (same) throw new Error(notUsableMessage(kind));
  }
  const slots: [Uint8Array, Uint8Array] = [
    await slotFor(lockSecretInput(kind, appSecret), dd),
    duressSecret === null ? randomSlot(dd) : await slotFor(lockSecretInput(kind, duressSecret), dd),
  ];
  await writePinRecord(backend, { ...record, kind, slots });
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
/** The passphrase field's form of the same sentence. */
export const PASSPHRASE_WAIT_OVER_MESSAGE = 'You can enter your passphrase again.';

// String-table ids (phase 22 item 6). In English: "Wrong PIN.", "Too many
// wrong PINs.", PIN_WAIT_OVER_MESSAGE, and the passphrase forms
// (scripts/check-i18n.mjs compares them with the constants above).
const ATTEMPT_WORDS: Record<LockKind, { wrong: StringId; tooMany: StringId; over: StringId }> = {
  pin: { wrong: 'lock.pin.wrong', tooMany: 'lock.pin.tooMany', over: 'lock.pin.waitOver' },
  phr: { wrong: 'lock.phr.wrong', tooMany: 'lock.phr.tooMany', over: 'lock.phr.waitOver' },
};

/**
 * The lock screen's sentence for an attempt's outcome (the same whichever
 * wallet a secret would open): it names a PIN or a passphrase after the
 * record's kind (outcome.lock; a PIN when absent).
 */
export function pinAttemptMessage(outcome: PinAttemptOutcome, now: number): string | null {
  const ids = ATTEMPT_WORDS[outcome.kind !== 'no-pin' && outcome.lock === 'phr' ? 'phr' : 'pin'];
  if (outcome.kind === 'wrong') return outcome.until > now ? `${t(ids.wrong)} ${tryAgainSentence(outcome.until, now)}` : `${t(ids.wrong)} ${t('lock.tryAgain')}`;
  if (outcome.kind === 'wait') return outcome.until > now ? `${t(ids.tooMany)} ${tryAgainSentence(outcome.until, now)}` : t(ids.over);
  if (outcome.kind === 'no-pin') return t('lock.noPin');
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
  /** Present (as "phr") only for a passphrase lock. */
  lock?: LockKind;
}

/** The countdown an outcome starts, or null when it starts none. */
export function pinCountdownOf(outcome: PinAttemptOutcome): PinCountdown | null {
  const lock = outcome.kind !== 'no-pin' && outcome.lock === 'phr' ? { lock: 'phr' as const } : {};
  if (outcome.kind === 'wait') return { kind: 'wait', until: outcome.until, ...lock };
  if (outcome.kind === 'wrong' && outcome.until > 0) return { kind: 'wrong', until: outcome.until, ...lock };
  return null;
}

/** The pad's (or the field's) line for a countdown at `now` ("… Try again in 29 seconds.", then the wait-over sentence). */
export function pinCountdownText(c: PinCountdown, now: number): string {
  const lock = c.lock ?? 'pin';
  const outcome: PinAttemptOutcome =
    c.kind === 'wait' ? { kind: 'wait', until: c.until, lock } : { kind: 'wrong', fails: PIN_FREE_ATTEMPTS, until: c.until, lock };
  return pinAttemptMessage(outcome, now) ?? '';
}

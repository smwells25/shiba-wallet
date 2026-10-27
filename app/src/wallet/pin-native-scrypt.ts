/**
 * The native scrypt the app PIN uses where the app binary carries it
 * (phase 22 item 2; the Chairperson's decision of 2026-10-19, threat model
 * F-81). ./pin.ts pinScrypt is still the one function that hashes a PIN; it
 * asks this module, once per app session, whether a native scrypt is
 * available and trustworthy, and falls back to the JavaScript scrypt of
 * @noble/hashes when it is not.
 *
 * WHERE THE NATIVE SCRYPT COMES FROM. react-native-quick-crypto 1.1.8 (MIT),
 * a Nitro module (react-native-nitro-modules 0.37.1, MIT). Its C++ class
 * HybridScrypt (node_modules/react-native-quick-crypto/cpp/scrypt/
 * HybridScrypt.cpp) calls OpenSSL's EVP_PBE_scrypt, the same function Node's
 * crypto.scrypt uses, and its asynchronous deriveKey runs the hash on a
 * background thread (Nitro's Promise::async), so the JavaScript thread stays
 * free while it works. The OpenSSL it links is the static build the library
 * pins (Android: the Maven artefact io.github.ronickg:openssl-static
 * 3.6.2-3 named in its android/build.gradle; iOS: a prebuilt OpenSSL 3.6.2
 * downloaded at pod install time and checked against a SHA-256 in
 * QuickCrypto.podspec). Nothing here makes a network request.
 *
 * WHY THE HYBRID OBJECT IS CALLED DIRECTLY. The package's JavaScript entry
 * (src/index.ts) loads the whole library and, as a side effect, writes
 * global.process.nextTick when it is missing; its scrypt() wrapper only
 * validates the parameters and calls the same native method. This module
 * therefore asks Nitro for the hybrid object named "Scrypt" and calls its
 * deriveKey(password, salt, N, r, p, maxmem, keylen), whose name and
 * signature are those of src/specs/scrypt.nitro.ts in the installed 1.1.8
 * (pinned by scripts/check-duress.mjs against that file; the package is
 * pinned to exactly 1.1.8 in package.json for this reason). Every parameter
 * is validated by pin.ts before it reaches this module.
 *
 * WHERE IT IS ABSENT. Expo Go does not contain these native modules, and
 * importing react-native-nitro-modules where its TurboModule is missing
 * throws (src/turbomodule/NativeNitroModules.ts: getEnforcing, then
 * ModuleNotFoundError). So nothing is imported until
 * TurboModuleRegistry.get('NitroModules') — the non-throwing lookup —
 * returned the module and Nitro reports a hybrid object named "Scrypt".
 * Under Node (the check scripts) there is no `require` in an ES module, so
 * the loader reports the native module as absent without touching anything.
 *
 * THE SELF-CHECK. The first time the native path would be used in a session
 * it hashes the third test vector of RFC 7914 section 12 (P =
 * "pleaseletmein", S = "SodiumChloride", N = 16384, r = 8, p = 1, dkLen =
 * 64; text fetched from www.rfc-editor.org/rfc/rfc7914.txt on 2026-10-19,
 * SHA-256 of the file df55932f…f10b197) and compares the output with the
 * digest printed in the RFC. Any difference, error or wrong length means the
 * native path is not used for the rest of the session, and the JavaScript
 * scrypt is used instead; the reason is kept for Settings → Developer and
 * written once to the console (the reason only: never a PIN, a salt or a
 * hash). A native hash that fails later in the session does the same.
 *
 * MAXMEM. OpenSSL refuses to run scrypt when its working memory would
 * exceed `maxmem`, and Node's default (32 MiB, which the library copies) is
 * below what N = 2^16 needs. OpenSSL's EVP_PBE_scrypt needs
 * 128·r·(N + 2) + 128·r·p bytes: 67,111,936 bytes at N = 2^16, r = 8,
 * p = 1 (Node 24.21.0 with OpenSSL 3.5.8 refuses 67,110,912 and accepts
 * 67,111,936, measured 2026-10-19). pinScryptMaxmem gives 128·r·N plus
 * 1 MiB of headroom: 68,157,440 bytes (65 MiB) at the PIN's size. It is a
 * ceiling OpenSSL checks, not an allocation; the allocation is the
 * 67,111,936 bytes above.
 */

import type { HybridObject } from 'react-native-nitro-modules';
import { t } from '../i18n/index.ts';

/** The library and version this module calls (package.json pins it exactly). */
export const NATIVE_SCRYPT_PACKAGE = 'react-native-quick-crypto';
export const NATIVE_SCRYPT_PACKAGE_VERSION = '1.1.8';
/** The Nitro hybrid object react-native-quick-crypto registers for scrypt. */
export const NATIVE_SCRYPT_HYBRID_NAME = 'Scrypt';

/** Headroom above scrypt's 128·r·N bytes, for OpenSSL's extra 128·r·(p + 2) bytes. */
export const PIN_SCRYPT_MAXMEM_HEADROOM = 1_048_576;

/** The maxmem passed to the native scrypt: 128·r·N + 1 MiB (68,157,440 bytes at N = 2^16, r = 8). */
export function pinScryptMaxmem(N: number, r: number): number {
  return 128 * r * N + PIN_SCRYPT_MAXMEM_HEADROOM;
}

/**
 * RFC 7914 section 12, the third test vector (the one with r = 8, p = 1):
 * scrypt(P = "pleaseletmein", S = "SodiumChloride", N = 16384, r = 8,
 * p = 1, dkLen = 64), the output as printed in the RFC.
 */
export const RFC7914_SELF_CHECK = Object.freeze({
  password: 'pleaseletmein',
  salt: 'SodiumChloride',
  N: 16384,
  r: 8,
  p: 1,
  dkLen: 64,
  expectedHex:
    '7023bdcb3afd7348461c06cd81fd38eb' +
    'fda8fbba904f8e3ea9b543f6545da1f2' +
    'd5432955613f0fcf62d49705242a9af9' +
    'e61e85dc0d651e40dfcf017b45575887',
});

/** One native scrypt call: bytes in, bytes out. */
export type NativeScryptDerive = (
  input: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  maxmem: number,
  dkLen: number,
) => Promise<Uint8Array>;

export type NativeScryptLoad =
  | { kind: 'loaded'; derive: NativeScryptDerive }
  /** Not in this build (Expo Go), or not a React Native runtime (Node). */
  | { kind: 'absent' }
  /** Present but could not be loaded. */
  | { kind: 'failed'; detail: string };

/** The PIN hashing path of this session. */
export type PinHashPath =
  | { kind: 'native' }
  | { kind: 'javascript'; reason: 'absent' | 'load-failed' | 'self-check-failed' | 'native-error'; detail: string | null };

export const PIN_HASH_NATIVE_LABEL = 'native scrypt (react-native-quick-crypto)';
export const PIN_HASH_JS_LABEL = 'JavaScript scrypt (@noble/hashes)';

/** The hybrid object's method this module calls (src/specs/scrypt.nitro.ts in 1.1.8). */
interface ScryptHybrid extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  deriveKey(password: ArrayBuffer, salt: ArrayBuffer, N: number, r: number, p: number, maxmem: number, keylen: number): Promise<ArrayBuffer>;
}

/** A fresh ArrayBuffer holding exactly these bytes (a subarray's offset never leaks into the call). */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function shortDetail(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** The app's loader: finds the native scrypt without throwing where it is missing. */
async function defaultLoader(): Promise<NativeScryptLoad> {
  // Under Node (the check scripts) this is an ES module with no `require`.
  if (typeof require !== 'function') return { kind: 'absent' };
  let rn: typeof import('react-native');
  try {
    // A CommonJS require, as in ./notifications.ts reactNative(): it reads
    // only the property used and keeps this module loadable under Node.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
    rn = require('react-native') as typeof import('react-native');
  } catch {
    return { kind: 'absent' };
  }
  try {
    if (rn.TurboModuleRegistry.get('NitroModules') == null) return { kind: 'absent' };
  } catch {
    return { kind: 'absent' };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- only after the TurboModule was found
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    if (!nitro.NitroModules.hasHybridObject(NATIVE_SCRYPT_HYBRID_NAME)) return { kind: 'absent' };
    const hybrid = nitro.NitroModules.createHybridObject<ScryptHybrid>(NATIVE_SCRYPT_HYBRID_NAME);
    const derive: NativeScryptDerive = async (input, salt, N, r, p, maxmem, dkLen) => {
      const out = await hybrid.deriveKey(ownBuffer(input), ownBuffer(salt), N, r, p, maxmem, dkLen);
      return new Uint8Array(out.slice(0));
    };
    return { kind: 'loaded', derive };
  } catch (e) {
    return { kind: 'failed', detail: shortDetail(e) };
  }
}

let loader: () => Promise<NativeScryptLoad> = defaultLoader;
let session: Promise<{ path: PinHashPath; derive: NativeScryptDerive | null }> | null = null;
let current: PinHashPath | null = null;

/** Replaces the loader (the check scripts only) and forgets the session's path. */
export function setNativeScryptLoaderForChecks(next: (() => Promise<NativeScryptLoad>) | null): void {
  loader = next ?? defaultLoader;
  session = null;
  current = null;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Runs the RFC 7914 vector through a native scrypt: null when it matches, else the reason. */
export async function nativeScryptSelfCheck(derive: NativeScryptDerive): Promise<string | null> {
  const v = RFC7914_SELF_CHECK;
  try {
    const out = await derive(asciiBytes(v.password), asciiBytes(v.salt), v.N, v.r, v.p, pinScryptMaxmem(v.N, v.r), v.dkLen);
    if (!(out instanceof Uint8Array) || out.length !== v.dkLen) return `the output had the wrong length (${out?.length ?? 'none'})`;
    return hex(out) === v.expectedHex ? null : 'the output differs from the RFC 7914 test vector';
  } catch (e) {
    return `the self-check hash failed (${shortDetail(e)})`;
  }
}

function warnFallback(path: PinHashPath): void {
  if (path.kind !== 'javascript' || path.reason === 'absent') return;
  // The reason only: no PIN, salt or hash is ever passed to this function.
  console.warn(`PIN hashing: not using ${PIN_HASH_NATIVE_LABEL} (${path.reason}${path.detail ? `: ${path.detail}` : ''}); using ${PIN_HASH_JS_LABEL}.`);
}

async function resolveSession(): Promise<{ path: PinHashPath; derive: NativeScryptDerive | null }> {
  let load: NativeScryptLoad;
  try {
    load = await loader();
  } catch (e) {
    load = { kind: 'failed', detail: shortDetail(e) };
  }
  let result: { path: PinHashPath; derive: NativeScryptDerive | null };
  if (load.kind === 'absent') result = { path: { kind: 'javascript', reason: 'absent', detail: null }, derive: null };
  else if (load.kind === 'failed') result = { path: { kind: 'javascript', reason: 'load-failed', detail: load.detail }, derive: null };
  else {
    const problem = await nativeScryptSelfCheck(load.derive);
    result = problem === null
      ? { path: { kind: 'native' }, derive: load.derive }
      : { path: { kind: 'javascript', reason: 'self-check-failed', detail: problem }, derive: null };
  }
  current = result.path;
  warnFallback(result.path);
  return result;
}

function sessionState(): Promise<{ path: PinHashPath; derive: NativeScryptDerive | null }> {
  if (!session) session = resolveSession();
  return session;
}

/** This session's PIN hashing path (loads the native module and runs the self-check the first time). */
export async function resolvePinHashPath(): Promise<PinHashPath> {
  return (await sessionState()).path;
}

/** The path as known now, without loading anything (null before the first resolution). */
export function currentPinHashPath(): PinHashPath | null {
  return current;
}

/** The native scrypt to use for the next hash, or null for the JavaScript scrypt. */
export async function nativeScryptForPin(): Promise<NativeScryptDerive | null> {
  const s = await sessionState();
  return s.path.kind === 'native' ? s.derive : null;
}

/** A native hash failed: the rest of the session uses the JavaScript scrypt. */
export function noteNativeScryptFailure(e: unknown): void {
  const path: PinHashPath = { kind: 'javascript', reason: 'native-error', detail: shortDetail(e) };
  session = Promise.resolve({ path, derive: null });
  current = path;
  warnFallback(path);
}

/** The label of a path, for the measurement's platform line. */
export function pinHashPathLabel(path: PinHashPath): string {
  return path.kind === 'native' ? PIN_HASH_NATIVE_LABEL : PIN_HASH_JS_LABEL;
}

/** Settings → Developer: the read-only line naming the path in use. */
export function pinHashPathLine(path: PinHashPath | null): string {
  // Through the string table (phase 23 item 8, fourth pass); the paths'
  // names and the "Technical detail: …" tail stay as they were. In English
  // exactly the lines this function built before.
  if (path === null) return t('settings.pinHash.checking');
  if (path.kind === 'native') return t('settings.pinHash.native', { label: PIN_HASH_NATIVE_LABEL });
  const detail = path.detail ? ` Technical detail: ${path.detail}` : '';
  switch (path.reason) {
    case 'absent':
      return t('settings.pinHash.absent', { label: PIN_HASH_JS_LABEL });
    case 'load-failed':
      return t('settings.pinHash.loadFailed', { label: PIN_HASH_JS_LABEL }) + detail;
    case 'self-check-failed':
      return t('settings.pinHash.selfCheckFailed', { label: PIN_HASH_JS_LABEL }) + detail;
    default:
      return t('settings.pinHash.nativeError', { label: PIN_HASH_JS_LABEL }) + detail;
  }
}

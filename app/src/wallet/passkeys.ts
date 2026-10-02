import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  KERNEL_WEBAUTHN_VALIDATOR,
  NodeClient,
  SmartAccountClient,
  base64UrlEncode,
  detectP256Precompile,
  kernelPasskeySpec,
  p256PublicKeyFromSec1,
  p256PublicKeyFromSpki,
  passkeyInstallCall,
  passkeyUninstallCalls,
  readKernelOwner,
  readPasskeyValidatorState,
  signErc1271WithPasskey,
  toBytes,
  toHex,
  verifyWebAuthnValidatorDeployment,
  webAuthnAuthenticatorIdHash,
  type Call,
  type JsonRpcTransport,
  type KernelPasskeySpec,
  type P256PublicKey,
  type PasskeyValidatorState,
  type SmartAccountSpec,
  type WebAuthnAssertion,
} from '@shiba-wallet/chains-evm';
import type { DerivedAccount } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-passkeys.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import {
  prepareAaCalls,
  resolveAaSender,
  summarizeAaReceipt,
  type AaClientBundle,
  type AaReceiptSummary,
  type AaSendQuote,
  type AaTokenSpend,
  type AaTokenTransfer,
} from './aa.ts';
import { utf8Decode } from './erc20.ts';
import type { KeyValueStore } from './tokens.ts';
import { PASSKEY_RP_ID_PLACEHOLDER, PASSKEY_RP_NAME } from '../config/passkey.ts';

/**
 * Passkey signer for the app (phase 8 item 3, app half), on the engine's
 * Kernel v3.3 WebAuthn support (packages/chains-evm/src/kernel-webauthn.ts,
 * whose header lists every source and the audit status; AGENTS.md phase 8
 * records the Sepolia simulations).
 *
 * WHAT A PASSKEY IS HERE. A P-256 key created by the phone's platform
 * authenticator (iOS Keychain passkeys, Android Credential Manager) and
 * installed into a DEPLOYED Kernel v3.3 smart account as an ADDITIONAL
 * validator (ZeroDev WebAuthnValidator v0.0.3, pinned by the engine). The
 * root validator stays the seed-derived ECDSA owner (ADR D1): the recovery
 * phrase keeps full control, can remove the passkey at any time, and the
 * account address does not change. Kernel's validator stores one key per
 * account, so there is one passkey per account.
 *
 * NO SECRET MATERIAL ON THE APP SIDE. The passkey's private key is generated
 * and kept inside the platform authenticator (Secure Enclave / StrongBox /
 * the OS credential provider) and never leaves it; the app only ever sees
 * the public key, the credential id and signed assertions. Everything this
 * module stores (PasskeyRecord, in AsyncStorage under PASSKEYS_KEY) is public
 * data: account, owner, chain, credential id, rpId, public key, validator
 * address, the precompile choice, timestamps and operation hashes.
 *
 * THE NATIVE LAYER (react-native-passkeys 0.4.2, an Expo module; see
 * ./passkey-native.ts, which is the only file that loads it, lazily). Its
 * create() / get() take and return JSON-shaped objects whose binary fields
 * are base64url strings (README; build/ReactNativePasskeys.types.d.ts
 * RegistrationResponseJSON / AuthenticationResponseJSON). This module talks
 * to it only through the PasskeyNative interface below, so
 * scripts/check-passkeys.mjs drives the exact decoding with a fake
 * authenticator. Decoding rules (each tested):
 *  - base64url: RFC 4648 section 5, canonical only (no padding, no other
 *    characters, no non-zero trailing bits) — base64UrlDecode.
 *  - Registration: the public key is taken from the attestationObject (CBOR,
 *    RFC 8949) → authData (W3C WebAuthn L3 section 6.1) → attested credential
 *    data (section 6.5.1) → COSE_Key (RFC 9052 section 7; EC2 parameters per
 *    RFC 9053 section 7.1.1; the ES256 example in WebAuthn section 6.5.1.1)
 *    → SEC1 0x04||x||y, on-curve checked by the engine. This works on both
 *    platforms because both return the attestationObject. The library's
 *    separate `publicKey` field is only CROSS-CHECKED: on Android it is the
 *    Credential Manager's DER SubjectPublicKeyInfo (91 bytes), but the
 *    library's iOS code (ios/PublicKey.swift getPublicKey) returns the raw
 *    64-byte x||y even though its typings say SPKI — both shapes (and SEC1)
 *    are accepted and must equal the COSE key, otherwise the registration is
 *    refused.
 *  - Assertion: authenticatorData and signature (ASN.1 DER, WebAuthn section
 *    6.5.5) are base64url bytes; clientDataJSON is base64url of the exact
 *    signed UTF-8 bytes and is decoded with a strict UTF-8 decoder whose
 *    output must re-encode to the same bytes. The engine's
 *    checkWebAuthnAssertion then enforces everything the validator checks
 *    (flags, the challenge at offset 23, low s, signature against the key).
 *  - The rpIdHash in authenticatorData must equal sha256(rpId) in both
 *    directions (a local check; the validator does not check it on-chain).
 *
 * THE SELF-CALL CAVEAT (engine D1 caveat, stated to the user as a risk). The
 * passkey is granted Kernel's execute(), which can also call the account
 * itself; self-calls pass Kernel's onlyEntryPointOrSelfOrRoot, so a stolen
 * passkey could install modules or replace the root validator (evicting the
 * recovery phrase). The engine's spec refuses passkey calls to the account
 * itself, but that guard is in this app, not on-chain.
 *
 * FEATURE GATE. Passkeys need the native module, which Expo Go does not
 * contain, and a relying-party id the Chairperson controls
 * (../config/passkey.ts). passkeyGate refuses — with PASSKEY_GATE_NOTE —
 * until both exist; every entry point shows that note instead of acting.
 */

export const PASSKEYS_KEY = 'shiba-wallet.passkeys.v1';
const STORE_VERSION = 1;

// ---------------------------------------------------------------------------
// User-facing text (one constant per statement, so every surface agrees)
// ---------------------------------------------------------------------------

export const PASSKEY_GATE_NOTE =
  'Passkeys need a development build with a configured rpId. Expo Go does not contain the native ' +
  'passkey module, and the passkey domain (rpId) is still the unconfigured placeholder. See ' +
  'docs/DEVICE_BUILDS.md → Passkeys.';

export const PASSKEY_EXPLANATION =
  'A passkey becomes an ADDITIONAL signer on your smart account, protected by this phone’s ' +
  'biometrics. Your recovery phrase stays in control: it can remove the passkey at any time, and ' +
  'your smart-account address does not change. One passkey per account.';

export const PASSKEY_SELF_CALL_RISK =
  'Risk: anyone who can use this passkey can spend from the smart account. The account contract ' +
  'would also let the passkey change the account’s own settings — even replace your recovery ' +
  'phrase as the owner. This wallet refuses to let the passkey do that, but the refusal is in this ' +
  'app, not enforced on-chain. Protect the passkey like your recovery phrase.';

export const PASSKEY_AUDIT_NOTE =
  'The WebAuthn validator version this wallet uses (ZeroDev WebAuthnValidator v0.0.3) has no ' +
  'published audit; the audited version had a flaw that this version fixes. Treat passkeys as ' +
  'experimental with real funds.';

export const PASSKEY_WIPE_NOTE =
  'Wiping this wallet forgets the passkey details on this device, but the passkey stays installed ' +
  'in your smart account and stays in your phone’s passkey list. Remove it here first if you no ' +
  'longer want it. A restored wallet can still remove an installed passkey (the recovery phrase ' +
  'controls the account).';

export const PASSKEY_OS_CLEANUP_NOTE =
  'The passkey itself stays in your phone’s password manager (iOS Passwords / Android Password ' +
  'Manager); delete it there if you like. It no longer works for this account.';

export const PASSKEY_SIMPLE_REFUSAL =
  'Passkeys need a Kernel v3.3 smart account: this network’s smart-account type is SimpleAccount. ' +
  'Choose Kernel v3.3 in Settings → Account Abstraction.';

export const PASSKEY_7702_REFUSAL =
  'Passkeys are offered only for Kernel smart accounts deployed by the factory. An address upgraded ' +
  'with EIP-7702 keeps its own key as an always-valid signer, and that combination is not supported.';

export const PASSKEY_UNDEPLOYED_REFUSAL =
  'Your Kernel smart account is not deployed yet. A passkey is installed into the account’s code, so ' +
  'send one smart-account transaction first (it deploys the account), then add a passkey.';

export const PASSKEY_NOT_OWNER_REFUSAL =
  'This wallet’s account is not the current owner of that Kernel account, so it cannot add or ' +
  'remove a passkey there.';

export const PASSKEY_ONE_PER_ACCOUNT_REFUSAL =
  'This account already has a passkey installed (the validator holds one passkey per account). ' +
  'Remove it first, then add a new one.';

export const PASSKEY_CANCELLED = 'The passkey prompt was cancelled. Nothing was signed.';

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

export type PasskeyGate =
  | { ok: true; rpId: string }
  | { ok: false; kind: 'native-missing' | 'rp-id-unset' | 'unsupported'; reason: string };

/**
 * Reserved names that can never be a real relying party: RFC 2606 ".invalid",
 * ".example", ".test", ".localhost", and RFC 6761 "localhost".
 */
const RESERVED_RP_SUFFIXES = ['.invalid', '.example', '.test', '.localhost'];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** True when `rpId` is a usable relying-party id (a real-looking domain, not a placeholder). */
export function isConfiguredRpId(rpId: string): boolean {
  if (rpId === PASSKEY_RP_ID_PLACEHOLDER) return false;
  if (!HOSTNAME.test(rpId)) return false;
  if (rpId === 'localhost') return false;
  return !RESERVED_RP_SUFFIXES.some((s) => rpId.endsWith(s));
}

/**
 * The passkey feature gate: the native module must be in this binary (it is
 * not in Expo Go, nor in a development build made before it was installed),
 * the rpId must be configured, and the platform must report passkey
 * support. Every refusal carries PASSKEY_GATE_NOTE or a plain reason.
 */
export function passkeyGate(input: {
  rpId: string;
  nativePresent: boolean;
  platformSupported: boolean | null;
}): PasskeyGate {
  if (!input.nativePresent) return { ok: false, kind: 'native-missing', reason: PASSKEY_GATE_NOTE };
  if (!isConfiguredRpId(input.rpId)) return { ok: false, kind: 'rp-id-unset', reason: PASSKEY_GATE_NOTE };
  if (input.platformSupported === false) {
    return {
      ok: false,
      kind: 'unsupported',
      reason:
        'This device does not support passkeys (react-native-passkeys reports no support: Android needs ' +
        'API level 28 or later, iOS 15 or later).',
    };
  }
  return { ok: true, rpId: input.rpId };
}

// ---------------------------------------------------------------------------
// base64url (RFC 4648 section 5)
// ---------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_INDEX = new Map([...B64URL].map((c, i) => [c, i] as const));

/**
 * Strict base64url decoder: only the URL-safe alphabet, no padding, no
 * whitespace, and the encoding must be canonical (re-encoding the result
 * gives the same string, so non-zero trailing bits are refused). WebAuthn
 * JSON serializations use this form (WebAuthn L3 "Base64URLString").
 */
export function base64UrlDecode(text: string, what = 'value'): Uint8Array {
  if (typeof text !== 'string') throw new Error(`${what} is not a base64url string`);
  if (text.length % 4 === 1) throw new Error(`${what} is not valid base64url (bad length)`);
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    const v: number[] = [];
    for (const c of chunk) {
      const n = B64URL_INDEX.get(c);
      if (n === undefined) throw new Error(`${what} is not valid base64url (character "${c}")`);
      v.push(n);
    }
    out[o++] = (v[0]! << 2) | (v[1]! >> 4);
    if (v.length > 2) out[o++] = ((v[1]! & 0x0f) << 4) | (v[2]! >> 2);
    if (v.length > 3) out[o++] = ((v[2]! & 0x03) << 6) | v[3]!;
  }
  const bytes = out.slice(0, o);
  if (base64UrlEncode(bytes) !== text) throw new Error(`${what} is not canonical base64url`);
  return bytes;
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (RFC 8949), only what WebAuthn registration needs
// ---------------------------------------------------------------------------

export type CborValue = number | bigint | Uint8Array | string | boolean | null | CborValue[] | Map<number | string, CborValue>;

/**
 * Decodes ONE CBOR data item starting at `offset` and returns it with the
 * offset just past it. Supported (RFC 8949 section 3.1): major types 0
 * (unsigned), 1 (negative), 2 (byte string), 3 (text string, strict UTF-8),
 * 4 (array), 5 (map with integer or text keys, duplicates refused), and the
 * simple values false / true / null. Refused: indefinite lengths, tags,
 * floats, other simple values, reserved additional information, nesting
 * deeper than 8 — none of which a WebAuthn attestation object or ES256
 * COSE_Key uses (WebAuthn L3 section 6.5.4; CTAP2 canonical CBOR).
 */
export function decodeCbor(bytes: Uint8Array, offset = 0, depth = 0): { value: CborValue; end: number } {
  if (depth > 8) throw new Error('CBOR nesting too deep');
  if (offset >= bytes.length) throw new Error('CBOR: unexpected end of data');
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let pos = offset + 1;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error('CBOR: unexpected end of data');
  };
  let arg: bigint;
  if (info < 24) arg = BigInt(info);
  else if (info >= 24 && info <= 27) {
    const n = 1 << (info - 24);
    need(n);
    arg = 0n;
    for (let i = 0; i < n; i++) arg = (arg << 8n) | BigInt(bytes[pos + i]!);
    pos += n;
  } else {
    throw new Error(`CBOR: unsupported additional information ${info} (indefinite or reserved)`);
  }
  const length = (): number => {
    if (arg > BigInt(bytes.length)) throw new Error('CBOR: length exceeds the data');
    return Number(arg);
  };
  switch (major) {
    case 0:
      return { value: arg <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(arg) : arg, end: pos };
    case 1: {
      const v = -1n - arg;
      return { value: v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v, end: pos };
    }
    case 2: {
      const n = length();
      need(n);
      return { value: bytes.slice(pos, pos + n), end: pos + n };
    }
    case 3: {
      const n = length();
      need(n);
      return { value: utf8Decode(bytes.slice(pos, pos + n)), end: pos + n };
    }
    case 4: {
      const n = length();
      const items: CborValue[] = [];
      for (let i = 0; i < n; i++) {
        const r = decodeCbor(bytes, pos, depth + 1);
        items.push(r.value);
        pos = r.end;
      }
      return { value: items, end: pos };
    }
    case 5: {
      const n = length();
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < n; i++) {
        const k = decodeCbor(bytes, pos, depth + 1);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') throw new Error('CBOR: unsupported map key type');
        if (map.has(k.value)) throw new Error(`CBOR: duplicate map key ${String(k.value)}`);
        const v = decodeCbor(bytes, k.end, depth + 1);
        map.set(k.value, v.value);
        pos = v.end;
      }
      return { value: map, end: pos };
    }
    case 7:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22) return { value: null, end: pos };
      throw new Error('CBOR: unsupported simple value or float');
    default:
      throw new Error('CBOR: tags are not supported');
  }
}

// ---------------------------------------------------------------------------
// Authenticator data and COSE keys (W3C WebAuthn L3 sections 6.1, 6.5.1)
// ---------------------------------------------------------------------------

/** authenticatorData flag bits (WebAuthn L3 section 6.1). */
export const AUTH_FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

export interface ParsedAuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  /** Present when the AT flag is set (registration). */
  attested?: { aaguid: Uint8Array; credentialId: Uint8Array; credentialPublicKey: Uint8Array };
}

/**
 * Parses authenticatorData: rpIdHash (32) || flags (1) || signCount (4, big
 * endian) || attested credential data when AT is set: aaguid (16) ||
 * credentialIdLength (2, big endian, <= 1023) || credentialId ||
 * credentialPublicKey (one CBOR item) || extensions when ED is set.
 */
export function parseAuthenticatorData(authData: Uint8Array): ParsedAuthenticatorData {
  if (authData.length < 37) throw new Error(`authenticatorData must be at least 37 bytes, got ${authData.length}`);
  const flags = authData[32]!;
  const signCount = ((authData[33]! << 24) >>> 0) + (authData[34]! << 16) + (authData[35]! << 8) + authData[36]!;
  const parsed: ParsedAuthenticatorData = { rpIdHash: authData.slice(0, 32), flags, signCount };
  if ((flags & AUTH_FLAG.AT) === 0) return parsed;
  let pos = 37;
  if (authData.length < pos + 18) throw new Error('authenticatorData: attested credential data is truncated');
  const aaguid = authData.slice(pos, pos + 16);
  pos += 16;
  const idLength = (authData[pos]! << 8) | authData[pos + 1]!;
  pos += 2;
  if (idLength === 0 || idLength > 1023) throw new Error(`authenticatorData: credentialIdLength ${idLength} is out of range`);
  if (authData.length < pos + idLength) throw new Error('authenticatorData: credential id is truncated');
  const credentialId = authData.slice(pos, pos + idLength);
  pos += idLength;
  const key = decodeCbor(authData, pos);
  if ((flags & AUTH_FLAG.ED) === 0 && key.end !== authData.length) {
    throw new Error('authenticatorData: unexpected bytes after the credential public key');
  }
  parsed.attested = { aaguid, credentialId, credentialPublicKey: authData.slice(pos, key.end) };
  return parsed;
}

/**
 * COSE_Key (RFC 9052 section 7) → SEC1 uncompressed 0x04 || x || y, for
 * ES256 only: kty (1) = 2 (EC2), alg (3) = -7 (ES256), crv (-1) = 1 (P-256),
 * x (-2) and y (-3) 32-byte byte strings (RFC 9053 section 7.1.1; WebAuthn L3
 * section 6.5.1.1). WebAuthn section 6.5.1 forbids other optional
 * parameters, so any other key is refused. The point is checked to be on
 * P-256 by the engine (p256PublicKeyFromSec1).
 */
export function coseEs256ToSec1(cose: Uint8Array): { sec1: Uint8Array; publicKey: P256PublicKey } {
  const { value, end } = decodeCbor(cose);
  if (end !== cose.length) throw new Error('COSE key: trailing bytes');
  if (!(value instanceof Map)) throw new Error('COSE key is not a CBOR map');
  for (const k of value.keys()) {
    if (![1, 3, -1, -2, -3].includes(k as number)) {
      throw new Error(`COSE key: unexpected parameter ${String(k)} (only ES256 EC2 keys are supported)`);
    }
  }
  if (value.get(1) !== 2) throw new Error('COSE key: kty is not EC2 (2)');
  if (value.get(3) !== -7) throw new Error('COSE key: alg is not ES256 (-7); only ES256 passkeys are supported');
  if (value.get(-1) !== 1) throw new Error('COSE key: crv is not P-256 (1)');
  const x = value.get(-2);
  const y = value.get(-3);
  if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error('COSE key: x is not a 32-byte string');
  if (!(y instanceof Uint8Array) || y.length !== 32) throw new Error('COSE key: y is not a 32-byte string');
  const sec1 = new Uint8Array(65);
  sec1[0] = 0x04;
  sec1.set(x, 1);
  sec1.set(y, 33);
  return { sec1, publicKey: p256PublicKeyFromSec1(sec1) };
}

/**
 * Decodes a public key as the native library reports it in `publicKey`:
 * 91-byte DER SubjectPublicKeyInfo (Android Credential Manager), 65-byte
 * SEC1, or 64-byte raw x||y (react-native-passkeys 0.4.2 on iOS,
 * ios/PublicKey.swift). Used only to cross-check the COSE key.
 */
export function decodePlatformPublicKey(bytes: Uint8Array): { format: 'spki' | 'sec1' | 'raw-xy'; publicKey: P256PublicKey } {
  if (bytes.length === 91) return { format: 'spki', publicKey: p256PublicKeyFromSpki(bytes) };
  if (bytes.length === 65) return { format: 'sec1', publicKey: p256PublicKeyFromSec1(bytes) };
  if (bytes.length === 64) {
    const sec1 = new Uint8Array(65);
    sec1[0] = 0x04;
    sec1.set(bytes, 1);
    return { format: 'raw-xy', publicKey: p256PublicKeyFromSec1(sec1) };
  }
  throw new Error(`Unrecognized public key encoding (${bytes.length} bytes)`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** sha256 of the rpId's UTF-8 bytes: the rpIdHash in authenticatorData (WebAuthn L3 section 6.1). */
export function rpIdHash(rpId: string): Uint8Array {
  return sha256(new TextEncoderLite().encode(rpId));
}

/** UTF-8 encoder (rpIds are ASCII; this avoids depending on a TextEncoder global). */
class TextEncoderLite {
  encode(text: string): Uint8Array {
    const out: number[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return Uint8Array.from(out);
  }
}

/** Strict UTF-8 decoding that must re-encode to exactly the same bytes (the signed bytes). */
export function exactUtf8(bytes: Uint8Array, what: string): string {
  let text: string;
  try {
    text = utf8Decode(bytes);
  } catch (e) {
    throw new Error(`${what} is not valid UTF-8 (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!equalBytes(new TextEncoderLite().encode(text), bytes)) throw new Error(`${what} does not round-trip as UTF-8`);
  return text;
}

// ---------------------------------------------------------------------------
// The native layer contract
// ---------------------------------------------------------------------------

/**
 * What the app needs from the native passkey module (react-native-passkeys
 * 0.4.2 create / get; ./passkey-native.ts adapts it). Requests and responses
 * are the WebAuthn JSON shapes with base64url binary fields. A null result
 * means the platform returned nothing (treated as cancelled).
 */
export interface PasskeyNative {
  create(request: PasskeyCreationRequest): Promise<unknown>;
  get(request: PasskeyAssertionRequest): Promise<unknown>;
}

export interface PasskeyCreationRequest {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout: number;
  authenticatorSelection: {
    authenticatorAttachment: 'platform';
    residentKey: 'required';
    requireResidentKey: true;
    userVerification: 'required';
  };
  attestation: 'none';
  excludeCredentials: { id: string; type: 'public-key' }[];
}

export interface PasskeyAssertionRequest {
  challenge: string;
  rpId: string;
  allowCredentials: { id: string; type: 'public-key' }[];
  userVerification: 'required';
  timeout: number;
}

const PROMPT_TIMEOUT_MS = 120_000;

/**
 * The registration request: ES256 only (alg -7, the only algorithm the
 * Kernel validator verifies), a platform authenticator, a discoverable
 * credential, user verification REQUIRED (the validator requires the UV
 * flag), attestation "none" (there is no server to verify attestation; the
 * key is trusted because THIS device just created it). The user handle is
 * random (WebAuthn: it must not contain personal data). `excludeIds` keeps a
 * second passkey for the same account from being created on this device.
 */
export function buildRegistrationRequest(args: {
  rpId: string;
  challenge: Uint8Array;
  userId: Uint8Array;
  userName: string;
  excludeIds?: string[];
}): PasskeyCreationRequest {
  if (args.challenge.length < 16) throw new Error('Registration challenge must be at least 16 random bytes');
  if (args.userId.length < 1 || args.userId.length > 64) throw new Error('User handle must be 1 to 64 bytes');
  return {
    challenge: base64UrlEncode(args.challenge),
    rp: { id: args.rpId, name: PASSKEY_RP_NAME },
    user: { id: base64UrlEncode(args.userId), name: args.userName, displayName: args.userName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: PROMPT_TIMEOUT_MS,
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
    excludeCredentials: (args.excludeIds ?? []).map((id) => ({ id, type: 'public-key' })),
  };
}

/**
 * The assertion request for one challenge (a userOpHash, or Kernel's ERC-1271
 * wrapped digest): the RAW 32 bytes as base64url (the platform puts exactly
 * this string into clientDataJSON.challenge), only the registered credential,
 * user verification required, the configured rpId.
 */
export function buildAssertionRequest(challenge: Uint8Array, credential: { credentialId: string; rpId: string }): PasskeyAssertionRequest {
  if (challenge.length !== 32) throw new Error(`A passkey challenge must be 32 bytes, got ${challenge.length}`);
  return {
    challenge: base64UrlEncode(challenge),
    rpId: credential.rpId,
    allowCredentials: [{ id: credential.credentialId, type: 'public-key' }],
    userVerification: 'required',
    timeout: PROMPT_TIMEOUT_MS,
  };
}

export interface PasskeyRegistration {
  /** Raw credential id bytes (public identifier, not a secret). */
  credentialId: Uint8Array;
  /** The same, base64url (how it is stored and passed back to the platform). */
  credentialIdB64: string;
  publicKey: P256PublicKey;
  /** 0x04 || x || y. */
  sec1: Uint8Array;
  /** How the library's separate publicKey field was encoded (it must match the COSE key), or absent. */
  platformPublicKeyFormat: 'spki' | 'sec1' | 'raw-xy' | 'absent';
  /** Attestation statement format reported (not verified; there is no server). */
  attestationFormat: string;
  /** BE flag: the platform may sync this passkey to other devices (iCloud Keychain / Google Password Manager). */
  backupEligible: boolean;
}

function field(obj: unknown, name: string): unknown {
  return typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[name] : undefined;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`The passkey response has no ${what}`);
  return value;
}

/**
 * Decodes and checks a registration response (react-native-passkeys create()
 * result) for `expected.rpId` and the registration challenge. See the module
 * header for the decoding rules. Throws a specific error on any mismatch.
 */
export function decodeRegistrationResponse(
  raw: unknown,
  expected: { rpId: string; challenge: Uint8Array },
): PasskeyRegistration {
  if (raw === null || raw === undefined) throw new Error(PASSKEY_CANCELLED);
  const type = field(raw, 'type');
  if (type !== undefined && type !== 'public-key') throw new Error(`Unexpected credential type ${String(type)}`);
  const rawIdText = requireString(field(raw, 'rawId') ?? field(raw, 'id'), 'credential id');
  const credentialId = base64UrlDecode(rawIdText, 'rawId');
  const idText = field(raw, 'id');
  if (typeof idText === 'string' && idText !== rawIdText) throw new Error('The credential id and rawId differ');
  const response = field(raw, 'response');
  const algorithm = field(response, 'publicKeyAlgorithm');
  if (algorithm !== undefined && algorithm !== null && algorithm !== -7) {
    throw new Error(`The passkey uses algorithm ${String(algorithm)}, not ES256 (-7)`);
  }

  // clientDataJSON: a webauthn.create for our challenge (local sanity check;
  // registration data never goes on-chain).
  const clientData = exactUtf8(
    base64UrlDecode(requireString(field(response, 'clientDataJSON'), 'clientDataJSON'), 'clientDataJSON'),
    'clientDataJSON',
  );
  let parsedClient: unknown;
  try {
    parsedClient = JSON.parse(clientData);
  } catch {
    throw new Error('Registration clientDataJSON is not JSON');
  }
  if (field(parsedClient, 'type') !== 'webauthn.create') throw new Error('Registration clientDataJSON type is not webauthn.create');
  if (field(parsedClient, 'challenge') !== base64UrlEncode(expected.challenge)) {
    throw new Error('Registration clientDataJSON challenge does not match the request');
  }

  // attestationObject → authData → attested credential data → COSE key.
  const att = base64UrlDecode(requireString(field(response, 'attestationObject'), 'attestationObject'), 'attestationObject');
  const decoded = decodeCbor(att);
  if (decoded.end !== att.length) throw new Error('attestationObject: trailing bytes');
  const map = decoded.value;
  if (!(map instanceof Map)) throw new Error('attestationObject is not a CBOR map');
  const fmt = map.get('fmt');
  const authData = map.get('authData');
  if (typeof fmt !== 'string') throw new Error('attestationObject has no fmt');
  if (!(authData instanceof Uint8Array)) throw new Error('attestationObject has no authData');
  const parsed = parseAuthenticatorData(authData);
  if (!equalBytes(parsed.rpIdHash, rpIdHash(expected.rpId))) {
    throw new Error(`The passkey was created for a different relying party than ${expected.rpId}`);
  }
  if ((parsed.flags & AUTH_FLAG.UP) === 0) throw new Error('Registration: user-presence (UP) flag is not set');
  if ((parsed.flags & AUTH_FLAG.UV) === 0) throw new Error('Registration: user-verification (UV) flag is not set');
  if (!parsed.attested) throw new Error('Registration: no attested credential data (AT flag not set)');
  if (!equalBytes(parsed.attested.credentialId, credentialId)) {
    throw new Error('Registration: the credential id in authenticatorData differs from rawId');
  }
  const { sec1, publicKey } = coseEs256ToSec1(parsed.attested.credentialPublicKey);

  // Cross-check the library's separate public-key field when present.
  let platformPublicKeyFormat: PasskeyRegistration['platformPublicKeyFormat'] = 'absent';
  const platformKey = field(response, 'publicKey');
  if (typeof platformKey === 'string' && platformKey.length > 0) {
    const other = decodePlatformPublicKey(base64UrlDecode(platformKey, 'publicKey'));
    if (other.publicKey.x !== publicKey.x || other.publicKey.y !== publicKey.y) {
      throw new Error('The platform reported a public key that differs from the one in the attestation');
    }
    platformPublicKeyFormat = other.format;
  }
  return {
    credentialId,
    credentialIdB64: base64UrlEncode(credentialId),
    publicKey,
    sec1,
    platformPublicKeyFormat,
    attestationFormat: fmt,
    backupEligible: (parsed.flags & AUTH_FLAG.BE) !== 0,
  };
}

/**
 * Decodes an assertion response (react-native-passkeys get() result) into
 * the engine's WebAuthnAssertion. Checks the credential is the registered one
 * and the rpIdHash is sha256(rpId); the engine's checkWebAuthnAssertion does
 * the rest (flags, challenge at offset 23, DER, low s, the signature itself).
 */
export function decodeAssertionResponse(
  raw: unknown,
  expected: { credentialId: string; rpId: string },
): WebAuthnAssertion {
  if (raw === null || raw === undefined) throw new Error(PASSKEY_CANCELLED);
  const rawIdText = requireString(field(raw, 'rawId') ?? field(raw, 'id'), 'credential id');
  const credentialId = base64UrlDecode(rawIdText, 'rawId');
  if (!equalBytes(credentialId, base64UrlDecode(expected.credentialId, 'stored credential id'))) {
    throw new Error('The platform answered with a different passkey than the one installed for this account');
  }
  const response = field(raw, 'response');
  const authenticatorData = base64UrlDecode(requireString(field(response, 'authenticatorData'), 'authenticatorData'), 'authenticatorData');
  const clientDataBytes = base64UrlDecode(requireString(field(response, 'clientDataJSON'), 'clientDataJSON'), 'clientDataJSON');
  const signature = base64UrlDecode(requireString(field(response, 'signature'), 'signature'), 'signature');
  const parsed = parseAuthenticatorData(authenticatorData);
  if (!equalBytes(parsed.rpIdHash, rpIdHash(expected.rpId))) {
    throw new Error(`The assertion is for a different relying party than ${expected.rpId}`);
  }
  return {
    authenticatorData,
    clientDataJSON: exactUtf8(clientDataBytes, 'clientDataJSON'),
    signature,
    credentialId,
  };
}

/** Plain text for a native passkey error (react-native-passkeys rejects with codes such as "UserCancelled"). */
export function describePasskeyError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/UserCancelled|cancel/i.test(text)) return PASSKEY_CANCELLED;
  if (/NoCredentials/i.test(text)) {
    return 'The phone has no matching passkey for this account (it may have been deleted from the password manager).';
  }
  if (/NotConfigured|NotSupported|domain|association|asset ?links/i.test(text)) {
    return `The phone refused the passkey request (${text}). Check that the rpId domain's association files are hosted correctly (docs/DEVICE_BUILDS.md → Passkeys).`;
  }
  return text;
}

/**
 * The engine's `assert` contract on top of the native module:
 * assert(challenge: 32 bytes) → { authenticatorData, clientDataJSON, signature
 * (DER), credentialId }. One platform prompt per call.
 */
export function makePasskeyAssert(
  native: PasskeyNative,
  credential: { credentialId: string; rpId: string },
): (challenge: Uint8Array) => Promise<WebAuthnAssertion> {
  return async (challenge: Uint8Array) => {
    const request = buildAssertionRequest(challenge, credential);
    let raw: unknown;
    try {
      raw = await native.get(request);
    } catch (e) {
      throw new Error(describePasskeyError(e));
    }
    return decodeAssertionResponse(raw, credential);
  };
}

/** Runs the platform registration and decodes it (one prompt). */
export async function registerPasskey(
  native: PasskeyNative,
  args: { rpId: string; challenge: Uint8Array; userId: Uint8Array; userName: string; excludeIds?: string[] },
): Promise<PasskeyRegistration> {
  const request = buildRegistrationRequest(args);
  let raw: unknown;
  try {
    raw = await native.create(request);
  } catch (e) {
    throw new Error(describePasskeyError(e));
  }
  return decodeRegistrationResponse(raw, { rpId: args.rpId, challenge: args.challenge });
}

// ---------------------------------------------------------------------------
// Credential metadata (public data only)
// ---------------------------------------------------------------------------

/**
 * Local lifecycle: installing = saved before the install op was submitted;
 * installed = included and read back from the chain; failed = refused or
 * reverted; removing = removal accepted by the bundler.
 */
export type PasskeyLocalStatus = 'installing' | 'installed' | 'failed' | 'removing';

export interface PasskeyRecord {
  /** CAIP-2 chain, e.g. eip155:11155111. */
  chain: string;
  /** The deployed Kernel v3.3 account the passkey is installed in (EIP-55). */
  account: string;
  /** The seed-derived owner EOA whose key installs and removes it (EIP-55). */
  owner: string;
  accountIndex: number;
  /** base64url credential id (a public identifier). */
  credentialId: string;
  rpId: string;
  /** P-256 public key coordinates, 0x + 64 hex each. */
  publicKey: { x: string; y: string };
  /** The WebAuthn validator module (the engine's pinned v0.0.3). */
  validator: string;
  /** Whether operations use the P256VERIFY precompile (else Daimo's verifier). */
  usePrecompiled: boolean;
  /** BE flag at registration: the platform may sync the passkey to other devices. */
  backupEligible: boolean;
  createdAt: number;
  installUserOpHash: string | null;
  removeUserOpHash: string | null;
  localStatus: PasskeyLocalStatus;
}

export interface PasskeyListLoad {
  records: PasskeyRecord[];
  corrupt: boolean;
  unreadable: boolean;
}

const LOCAL_STATUSES: readonly PasskeyLocalStatus[] = ['installing', 'installed', 'failed', 'removing'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const USEROP_HASH = /^0x[0-9a-fA-F]{64}$/;

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address.toLowerCase()));
}

export function passkeyRecordKey(chain: string, account: string): string {
  return `${chain}|${account.toLowerCase()}`;
}

function wordHex(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

export function recordPublicKey(record: PasskeyRecord): P256PublicKey {
  return { x: BigInt(record.publicKey.x), y: BigInt(record.publicKey.y) };
}

function eip155Decimal(chain: string): bigint {
  const match = /^eip155:([1-9][0-9]*)$/.exec(chain);
  if (!match) throw new Error(`Not an EVM chain id: ${chain}`);
  return BigInt(match[1]!);
}

function reviveRecord(value: unknown): PasskeyRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  try {
    if (typeof v.chain !== 'string') return null;
    eip155Decimal(v.chain);
    if (typeof v.account !== 'string' || !ADDRESS.test(v.account)) return null;
    if (typeof v.owner !== 'string' || !ADDRESS.test(v.owner)) return null;
    if (typeof v.accountIndex !== 'number' || !Number.isSafeInteger(v.accountIndex) || v.accountIndex < 0) return null;
    if (typeof v.credentialId !== 'string') return null;
    base64UrlDecode(v.credentialId, 'credentialId');
    if (typeof v.rpId !== 'string' || !isConfiguredRpId(v.rpId)) return null;
    const pk = v.publicKey as Record<string, unknown> | null;
    if (!pk || typeof pk.x !== 'string' || typeof pk.y !== 'string' || !WORD.test(pk.x) || !WORD.test(pk.y)) return null;
    // On-curve check (throws on a corrupted key).
    const sec1 = new Uint8Array(65);
    sec1[0] = 0x04;
    sec1.set(toBytes(pk.x), 1);
    sec1.set(toBytes(pk.y), 33);
    p256PublicKeyFromSec1(sec1);
    if (typeof v.validator !== 'string' || !same(v.validator, KERNEL_WEBAUTHN_VALIDATOR.address)) return null;
    if (typeof v.usePrecompiled !== 'boolean' || typeof v.backupEligible !== 'boolean') return null;
    if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null;
    const hashOrNull = (h: unknown) => h === null || (typeof h === 'string' && USEROP_HASH.test(h));
    if (!hashOrNull(v.installUserOpHash) || !hashOrNull(v.removeUserOpHash)) return null;
    if (!LOCAL_STATUSES.includes(v.localStatus as PasskeyLocalStatus)) return null;
    return {
      chain: v.chain,
      account: checksum(v.account),
      owner: checksum(v.owner),
      accountIndex: v.accountIndex,
      credentialId: v.credentialId,
      rpId: v.rpId,
      publicKey: { x: pk.x, y: pk.y },
      validator: KERNEL_WEBAUTHN_VALIDATOR.address,
      usePrecompiled: v.usePrecompiled,
      backupEligible: v.backupEligible,
      createdAt: v.createdAt,
      installUserOpHash: (v.installUserOpHash as string | null) ?? null,
      removeUserOpHash: (v.removeUserOpHash as string | null) ?? null,
      localStatus: v.localStatus as PasskeyLocalStatus,
    };
  } catch {
    return null;
  }
}

type RawRead = { state: 'empty' } | { state: 'ok'; records: Record<string, unknown> } | { state: 'unreadable' };

async function readRaw(store: KeyValueStore): Promise<RawRead> {
  let text: string | null;
  try {
    text = await store.getItem(PASSKEYS_KEY);
  } catch {
    return { state: 'unreadable' };
  }
  if (text === null) return { state: 'empty' };
  try {
    const parsed = JSON.parse(text) as { version?: unknown; records?: unknown };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.version !== STORE_VERSION ||
      typeof parsed.records !== 'object' ||
      parsed.records === null ||
      Array.isArray(parsed.records)
    ) {
      return { state: 'unreadable' };
    }
    return { state: 'ok', records: parsed.records as Record<string, unknown> };
  } catch {
    return { state: 'unreadable' };
  }
}

/** Every stored passkey record. Never throws. */
export async function loadPasskeys(store: KeyValueStore = AsyncStorage): Promise<PasskeyListLoad> {
  const read = await readRaw(store);
  if (read.state === 'empty') return { records: [], corrupt: false, unreadable: false };
  if (read.state === 'unreadable') return { records: [], corrupt: true, unreadable: true };
  const records: PasskeyRecord[] = [];
  let dropped = 0;
  for (const [key, value] of Object.entries(read.records)) {
    const record = reviveRecord(value);
    if (!record || key !== passkeyRecordKey(record.chain, record.account)) {
      dropped += 1;
      continue;
    }
    records.push(record);
  }
  return { records, corrupt: dropped > 0, unreadable: false };
}

/** The passkey record for one owner on one chain (one smart account per owner and chain), or null. */
export async function passkeyRecordForOwner(
  chain: string,
  owner: string,
  store: KeyValueStore = AsyncStorage,
): Promise<PasskeyRecord | null> {
  const { records } = await loadPasskeys(store);
  return records.find((r) => r.chain === chain && same(r.owner, owner)) ?? null;
}

/** The passkey record for one smart account on one chain, or null. */
export async function passkeyRecordForAccount(
  chain: string,
  account: string,
  store: KeyValueStore = AsyncStorage,
): Promise<PasskeyRecord | null> {
  const { records } = await loadPasskeys(store);
  return records.find((r) => r.chain === chain && same(r.account, account)) ?? null;
}

const UNREADABLE_MESSAGE =
  'The saved passkey details could not be read, so nothing was changed. Use "Reset passkey list" on ' +
  'the Passkey screen (passkeys installed on-chain are not affected).';

async function writeRecord(record: PasskeyRecord | null, key: string, store: KeyValueStore): Promise<void> {
  const read = await readRaw(store);
  if (read.state === 'unreadable') throw new Error(UNREADABLE_MESSAGE);
  const records = read.state === 'ok' ? { ...read.records } : {};
  if (record) records[key] = record;
  else delete records[key];
  await store.setItem(PASSKEYS_KEY, JSON.stringify({ version: STORE_VERSION, records }));
}

export async function savePasskeyRecord(record: PasskeyRecord, store: KeyValueStore = AsyncStorage): Promise<void> {
  await writeRecord(record, passkeyRecordKey(record.chain, record.account), store);
}

async function updateRecord(record: PasskeyRecord, patch: Partial<PasskeyRecord>, store: KeyValueStore): Promise<PasskeyRecord> {
  const next = { ...record, ...patch };
  await savePasskeyRecord(next, store);
  return next;
}

/** Clears the local list (explicit user action, or the wallet wipe). On-chain passkeys are not affected. */
export async function resetPasskeys(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(PASSKEYS_KEY, JSON.stringify({ version: STORE_VERSION, records: {} }));
}

// ---------------------------------------------------------------------------
// Eligibility and on-chain status
// ---------------------------------------------------------------------------

export type PasskeyAccountResolution =
  | { ok: true; account: string; state: PasskeyValidatorState }
  | { ok: false; reason: string };

/**
 * Whether the active account can hold a passkey on the active chain: a
 * DEPLOYED Kernel v3.3 account (factory-deployed, or recovered and attached)
 * whose root validator is the ECDSA validator and whose owner is
 * `ownerAddress`. Refuses, in plain words: SimpleAccount, an EIP-7702
 * upgrade, an undeployed account, another owner. Read-only.
 */
export async function resolvePasskeyAccount(bundle: AaClientBundle, ownerAddress: string): Promise<PasskeyAccountResolution> {
  const reported = await new NodeClient(bundle.node).chainId();
  if (reported !== bundle.chainId) {
    return { ok: false, reason: `The RPC endpoint is chain id ${reported}, expected ${bundle.chainId}. Check the endpoint in Settings.` };
  }
  if (bundle.accountType === 'simple') return { ok: false, reason: PASSKEY_SIMPLE_REFUSAL };
  if (bundle.accountType === 'kernel-7702') return { ok: false, reason: PASSKEY_7702_REFUSAL };
  let account: string;
  try {
    account = await resolveAaSender(bundle, ownerAddress);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const code = (await bundle.node('eth_getCode', [account, 'latest'])) as string;
  if (!code || code === '0x' || code === '0x0') return { ok: false, reason: PASSKEY_UNDEPLOYED_REFUSAL };
  if (code.toLowerCase().startsWith('0xef0100')) return { ok: false, reason: PASSKEY_7702_REFUSAL };
  try {
    const owner = await readKernelOwner(bundle.node, account, bundle.kernel?.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator);
    if (!owner.ecdsaRoot) {
      return { ok: false, reason: `The account’s root validator is ${owner.rootValidator}, not the ECDSA validator.` };
    }
    if (!same(owner.owner, ownerAddress)) return { ok: false, reason: PASSKEY_NOT_OWNER_REFUSAL };
    const state = await readPasskeyValidatorState(bundle.node, account);
    return { ok: true, account: checksum(account), state };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export type PasskeyChainStatus =
  /** Installed on-chain with exactly the record's key. */
  | { kind: 'active' }
  /** No passkey installed on-chain. */
  | { kind: 'none' }
  /** A passkey is installed, but not the one this device knows (or this device knows none). */
  | { kind: 'other'; publicKey: P256PublicKey }
  /** Kernel config and the validator storage disagree (e.g. a half-removed install). */
  | { kind: 'partial'; detail: string }
  | { kind: 'unknown'; reason: string };

/** Classifies the engine's readPasskeyValidatorState against the local record (if any). */
export function classifyPasskeyState(state: PasskeyValidatorState, record: PasskeyRecord | null): PasskeyChainStatus {
  const zeroHook = /^0x0{40}$/i.test(state.hook);
  if (state.installed) {
    if (record && state.publicKey) {
      const key = recordPublicKey(record);
      if (state.publicKey.x === key.x && state.publicKey.y === key.y) return { kind: 'active' };
    }
    return { kind: 'other', publicKey: state.publicKey! };
  }
  if (zeroHook && !state.executeAllowed && state.publicKey === null) return { kind: 'none' };
  return {
    kind: 'partial',
    detail:
      `hook ${state.hook}, execute ${state.executeAllowed ? 'granted' : 'not granted'}, ` +
      `stored key ${state.publicKey ? 'present' : 'none'}, validation nonce ${state.validationNonce} ` +
      `(valid from ${state.validNonceFrom})`,
  };
}

/** The account's passkey status, never throwing ('unknown' with the reason instead). */
export async function readPasskeyStatus(
  node: JsonRpcTransport,
  account: string,
  record: PasskeyRecord | null,
): Promise<PasskeyChainStatus> {
  try {
    return classifyPasskeyState(await readPasskeyValidatorState(node, account), record);
  } catch (e) {
    return { kind: 'unknown', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Brings the local record in line with the chain when the receipt wait ended
 * early (timeout, app closed): a record still 'installing' or 'failed' whose
 * exact key the chain shows as installed becomes 'installed'. Nothing else is
 * changed. Returns the (possibly updated) record and the status.
 */
export async function reconcilePasskeyRecord(
  node: JsonRpcTransport,
  record: PasskeyRecord,
  store: KeyValueStore,
): Promise<{ record: PasskeyRecord; status: PasskeyChainStatus }> {
  const status = await readPasskeyStatus(node, record.account, record);
  if (status.kind === 'active' && (record.localStatus === 'installing' || record.localStatus === 'failed')) {
    return { record: await updateRecord(record, { localStatus: 'installed' }, store), status };
  }
  return { record, status };
}

export function passkeyStatusText(status: PasskeyChainStatus): string {
  if (status.kind === 'active') return 'Installed — this phone’s passkey can sign for the smart account';
  if (status.kind === 'none') return 'No passkey installed';
  if (status.kind === 'other') return 'A passkey this device does not know is installed (remove it if you do not recognise it)';
  if (status.kind === 'partial') return `Partly installed on-chain (${status.detail}); remove it to clean up`;
  return `Status unknown: ${status.reason}`;
}

// ---------------------------------------------------------------------------
// Install and removal (root-signed through the normal AA confirm)
// ---------------------------------------------------------------------------

export interface PasskeyInstallPlan {
  quote: AaSendQuote;
  call: Call;
  usePrecompiled: boolean;
}

/**
 * Verifies the pinned validator's code on this chain (the engine's
 * verifyWebAuthnValidatorDeployment), refuses when the account already holds
 * a passkey (one per account), detects the P256VERIFY precompile, and prices
 * the engine's passkeyInstallCall as ONE root-signed operation through
 * prepareAaCalls — the bundler estimate is the pre-flight gate.
 */
export async function preparePasskeyInstall(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  registration: Pick<PasskeyRegistration, 'publicKey' | 'credentialId'>,
): Promise<PasskeyInstallPlan> {
  await verifyWebAuthnValidatorDeployment(bundle.node);
  const state = await readPasskeyValidatorState(bundle.node, account);
  const status = classifyPasskeyState(state, null);
  if (status.kind === 'other') throw new Error(PASSKEY_ONE_PER_ACCOUNT_REFUSAL);
  if (status.kind === 'partial') {
    throw new Error(`The account’s passkey slot is in an unexpected state (${status.detail}). Remove the passkey first.`);
  }
  const usePrecompiled = await detectP256Precompile(bundle.node);
  const call = passkeyInstallCall(account, registration.publicKey, webAuthnAuthenticatorIdHash(registration.credentialId));
  const quote = await prepareAaCalls(bundle, ownerAddress, [call], { displayTo: account });
  if (!same(quote.sender, account)) throw new Error(`The configured smart account is ${quote.sender}, not ${account}. Nothing was signed.`);
  if (!quote.deployed) throw new Error(PASSKEY_UNDEPLOYED_REFUSAL);
  if (quote.eip7702) throw new Error(PASSKEY_7702_REFUSAL);
  return { quote, call, usePrecompiled };
}

function sameCalls(a: Call[], b: Call[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => same(c.to, b[i]!.to) && c.value === b[i]!.value && toHex(c.data) === toHex(b[i]!.data))
  );
}

/**
 * Saves the credential record (status installing) and submits the install.
 * `submit` signs with the OWNER key (in the app: signWith → sendAa after the
 * biometric gate). The quoted call is byte-checked against the engine's
 * passkeyInstallCall for this exact key and credential first. When submit
 * throws, the record stays as 'failed' so the on-chain status decides what
 * happens next.
 */
export async function installPasskey(args: {
  plan: PasskeyInstallPlan;
  registration: Pick<PasskeyRegistration, 'publicKey' | 'credentialId' | 'backupEligible'>;
  chain: string;
  account: string;
  owner: string;
  accountIndex: number;
  rpId: string;
  store: KeyValueStore;
  submit: (quote: AaSendQuote) => Promise<{ userOpHash: string }>;
}): Promise<{ record: PasskeyRecord; userOpHash: string }> {
  const expected = passkeyInstallCall(
    args.account,
    args.registration.publicKey,
    webAuthnAuthenticatorIdHash(args.registration.credentialId),
  );
  if (!sameCalls(args.plan.quote.calls, [expected]) || !sameCalls([args.plan.call], [expected])) {
    throw new Error('The quoted operation is not the passkey install it claims to be. Nothing was signed.');
  }
  if (!isConfiguredRpId(args.rpId)) throw new Error(PASSKEY_GATE_NOTE);
  let record: PasskeyRecord = {
    chain: args.chain,
    account: checksum(args.account),
    owner: checksum(args.owner),
    accountIndex: args.accountIndex,
    credentialId: base64UrlEncode(args.registration.credentialId),
    rpId: args.rpId,
    publicKey: { x: wordHex(args.registration.publicKey.x), y: wordHex(args.registration.publicKey.y) },
    validator: KERNEL_WEBAUTHN_VALIDATOR.address,
    usePrecompiled: args.plan.usePrecompiled,
    backupEligible: args.registration.backupEligible,
    createdAt: Date.now(),
    installUserOpHash: null,
    removeUserOpHash: null,
    localStatus: 'installing',
  };
  await savePasskeyRecord(record, args.store);
  let userOpHash: string;
  try {
    ({ userOpHash } = await args.submit(args.plan.quote));
  } catch (e) {
    await updateRecord(record, { localStatus: 'failed' }, args.store).catch(() => undefined);
    throw e;
  }
  record = await updateRecord(record, { installUserOpHash: userOpHash }, args.store);
  return { record, userOpHash };
}

/** Waits for the install receipt; 'installed' only when it succeeded AND the chain shows this exact key. */
export async function finalizePasskeyInstall(
  bundle: Pick<AaClientBundle, 'client' | 'node'>,
  record: PasskeyRecord,
  store: KeyValueStore,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ record: PasskeyRecord; receipt: AaReceiptSummary; status: PasskeyChainStatus }> {
  if (!record.installUserOpHash) throw new Error('This passkey has no install operation to wait for.');
  const raw = await bundle.client.waitForReceipt(record.installUserOpHash, {
    timeoutMs: options.timeoutMs ?? 120_000,
    pollMs: options.pollMs ?? 3_000,
  });
  const receipt = summarizeAaReceipt(raw);
  const status = await readPasskeyStatus(bundle.node, record.account, record);
  const next =
    receipt.success === true && status.kind === 'active'
      ? await updateRecord(record, { localStatus: 'installed' }, store)
      : receipt.success === false
        ? await updateRecord(record, { localStatus: 'failed' }, store)
        : record;
  return { record: next, receipt, status };
}

/** Quotes the root-signed removal (the engine's passkeyUninstallCalls: uninstallValidation + revoke execute). */
export async function preparePasskeyRemove(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
): Promise<AaSendQuote> {
  const quote = await prepareAaCalls(bundle, ownerAddress, passkeyUninstallCalls(account), { displayTo: account });
  if (!same(quote.sender, account)) {
    throw new Error(`This network’s smart account is ${quote.sender}, not ${account}. Nothing was signed.`);
  }
  if (quote.eip7702) throw new Error(PASSKEY_7702_REFUSAL);
  return quote;
}

/**
 * Submits a removal (owner-signed through `submit`) after byte-checking the
 * calls against the engine's passkeyUninstallCalls; marks a known record
 * 'removing'. Works without a record too (a passkey this device does not
 * know, e.g. after a restore).
 */
export async function removePasskey(args: {
  chain: string;
  account: string;
  quote: AaSendQuote;
  store: KeyValueStore;
  submit: (quote: AaSendQuote) => Promise<{ userOpHash: string }>;
}): Promise<{ userOpHash: string; record: PasskeyRecord | null }> {
  if (!sameCalls(args.quote.calls, passkeyUninstallCalls(args.account))) {
    throw new Error('The quoted operation is not this account’s passkey removal. Nothing was signed.');
  }
  const { userOpHash } = await args.submit(args.quote);
  const existing = await passkeyRecordForAccount(args.chain, args.account, args.store);
  const record = existing
    ? await updateRecord(existing, { localStatus: 'removing', removeUserOpHash: userOpHash }, args.store).catch(() => existing)
    : null;
  return { userOpHash, record };
}

/**
 * Waits for the removal receipt; once the chain shows no passkey, the local
 * record is forgotten (the credential details are deleted from this device).
 */
export async function finalizePasskeyRemove(
  bundle: Pick<AaClientBundle, 'client' | 'node'>,
  chain: string,
  account: string,
  userOpHash: string,
  store: KeyValueStore,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ receipt: AaReceiptSummary; status: PasskeyChainStatus; forgotten: boolean }> {
  const raw = await bundle.client.waitForReceipt(userOpHash, {
    timeoutMs: options.timeoutMs ?? 120_000,
    pollMs: options.pollMs ?? 3_000,
  });
  const receipt = summarizeAaReceipt(raw);
  const record = await passkeyRecordForAccount(chain, account, store);
  const status = await readPasskeyStatus(bundle.node, account, record);
  let forgotten = false;
  if (receipt.success === true && status.kind === 'none') {
    await forgetPasskey({ node: bundle.node, chain, account, store });
    forgotten = true;
  }
  return { receipt, status, forgotten };
}

/**
 * Deletes the local record. Refused while the chain still shows a passkey
 * (or cannot be read), so the wallet never forgets something live.
 */
export async function forgetPasskey(args: {
  node: JsonRpcTransport;
  chain: string;
  account: string;
  store: KeyValueStore;
}): Promise<void> {
  const status = await readPasskeyStatus(args.node, args.account, null);
  if (status.kind !== 'none') {
    throw new Error(
      status.kind === 'unknown'
        ? `The on-chain status could not be read (${status.reason}), so the passkey details were kept.`
        : 'A passkey is still installed on-chain. Remove it first.',
    );
  }
  await writeRecord(null, passkeyRecordKey(args.chain, args.account), args.store);
}

// ---------------------------------------------------------------------------
// Passkey-signed operations (the owner key is never involved)
// ---------------------------------------------------------------------------

/**
 * Gas padding for passkey operations. The estimate uses the engine's stub
 * (a 244-byte clientDataJSON, the real usePrecompiled value); the
 * validator's WebAuthn.verifySignature runs the full P-256 check even for
 * the failing stub (it defers the result: kernel-7579-plugins
 * src/utils/WebAuthn.sol, the "deferredResult" comment), so verification gas
 * is representative. A real clientDataJSON may be longer than the stub, which
 * costs more calldata (preVerificationGas) and hashing, hence the margin.
 * Applied identically to the quote and by SmartAccountClient at send time.
 */
export const PASSKEY_GAS_PADDING = { verification: 110, preVerification: 115 } as const;

export interface PasskeyBundle extends AaClientBundle {
  passkey: { spec: KernelPasskeySpec; record: PasskeyRecord };
}

/**
 * The AaClientBundle for passkey-signed operations on `record.account`: the
 * engine's kernelPasskeySpec wrapped so the shared quote code
 * (prepareAaCalls, which resolves the sender from an address-only stand-in)
 * can drive it, plus the engine's transport routing — routeNode (the passkey
 * nonce key) and routeBundler (the passkey prompt runs at
 * eth_sendUserOperation, after estimation; SmartAccountSpec.signUserOpHash is
 * synchronous). No paymaster: passkey operations are paid by the account
 * (sponsorship together with a passkey was not tested).
 */
export function createPasskeyBundle(
  base: Pick<AaClientBundle, 'node' | 'bundler' | 'chainId' | 'accountIndex'>,
  record: PasskeyRecord,
  assert: (challenge: Uint8Array) => Promise<WebAuthnAssertion>,
): PasskeyBundle {
  if (eip155Decimal(record.chain) !== base.chainId) throw new Error('This passkey belongs to another network.');
  if (record.localStatus !== 'installed') throw new Error('This passkey is not installed (check the Passkey screen).');
  const engine = kernelPasskeySpec({
    account: record.account,
    publicKey: recordPublicKey(record),
    assert,
    usePrecompiled: record.usePrecompiled,
    chainId: base.chainId,
    validator: record.validator,
  });
  const spec: SmartAccountSpec = {
    // The quote path passes an address-only stand-in; only the passkey
    // account's own address is accepted.
    async getAddress(owner: DerivedAccount) {
      if (!same(owner.address, record.account)) {
        throw new Error('The passkey signs only for its own smart account.');
      }
      return engine.signer.address;
    },
    getFactoryArgs: () => engine.getFactoryArgs(engine.signer),
    encodeCalls: (calls: Call[]) => engine.encodeCalls(calls),
    // The engine refuses every signer but spec.signer (whose sign() throws),
    // so the seed key can never sign here.
    signUserOpHash: (owner: DerivedAccount, hash: Uint8Array) => engine.signUserOpHash(owner, hash),
    stubSignature: () => engine.stubSignature(),
  };
  const node = engine.routeNode(base.node);
  const bundler = engine.routeBundler(base.bundler);
  const client = new SmartAccountClient({
    chainId: base.chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    gasPaddingPct: { ...PASSKEY_GAS_PADDING },
  });
  return {
    client,
    spec,
    node,
    bundler,
    chainId: base.chainId,
    sponsored: false,
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    accountIndex: base.accountIndex,
    passkey: { spec: engine, record },
  };
}

const pad = (value: bigint, pct: number) => (value * BigInt(pct)) / 100n;

/**
 * The passkey-signed quote for `calls`: prepareAaCalls over the passkey
 * bundle (same chain-id check, balance checks and bundler-estimate gate as
 * any smart-account send, with the passkey nonce key and stub signature),
 * then the PASSKEY_GAS_PADDING margin applied to the gas limits, the fee and
 * the balance check. Calls to the account itself are refused by the engine
 * (the self-call guard).
 */
export async function preparePasskeyCalls(
  bundle: PasskeyBundle,
  calls: Call[],
  options: { tokenSpend?: AaTokenSpend; displayTo?: string; token?: AaTokenTransfer } = {},
): Promise<AaSendQuote> {
  const base = await prepareAaCalls(bundle, bundle.passkey.record.account, calls, options);
  const verificationGasLimit = pad(base.verificationGasLimit, PASSKEY_GAS_PADDING.verification);
  const preVerificationGas = pad(base.preVerificationGas, PASSKEY_GAS_PADDING.preVerification);
  const fee = (base.callGasLimit + verificationGasLimit + preVerificationGas) * base.maxFeePerGas;
  if (base.amount + fee > base.senderBalance) {
    throw new Error(
      `Insufficient funds: the smart account pays its own gas, and sending ${base.amount} wei plus a ` +
        `worst-case fee of ${fee} wei exceeds its balance of ${base.senderBalance} wei.`,
    );
  }
  return { ...base, verificationGasLimit, preVerificationGas, fee, total: base.amount + fee, passkey: true };
}

/**
 * Submits a passkey quote: SmartAccountClient.sendCalls with the passkey
 * signer stand-in (spec.signer, which cannot sign by itself); the platform
 * prompt runs inside the routed bundler at submission, and the engine checks
 * the assertion against the installed key before forwarding. signWith, the
 * mnemonic and the owner key are not reachable from here.
 */
export async function sendPasskeyCalls(
  bundle: PasskeyBundle,
  quote: AaSendQuote,
): Promise<{ userOpHash: string; signature: Uint8Array | undefined }> {
  if (!quote.passkey) throw new Error('This operation was not prepared for the passkey signer. Nothing was signed.');
  if (!same(quote.sender, bundle.passkey.record.account)) {
    throw new Error('The operation was prepared for another account. Nothing was signed.');
  }
  const { userOpHash } = await bundle.client.sendCalls(bundle.passkey.spec.signer, quote.calls, {
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
  });
  return { userOpHash, signature: bundle.passkey.spec.submittedSignature(userOpHash) };
}

/** The "Test passkey" operation: one zero-value call to the owner EOA (a call to the account itself is refused by design). */
export function passkeyTestCalls(record: PasskeyRecord): Call[] {
  return [{ to: record.owner, value: 0n, data: new Uint8Array(0) }];
}

/**
 * A dApp signature (ERC-1271) made by the passkey for a smart-account
 * WalletConnect session: the engine's signErc1271WithPasskey (0x01 ||
 * validator || WebAuthn envelope over Kernel's EIP-712 wrapper of `hash`).
 * Refuses unless the session's account is the passkey's account on this
 * chain.
 */
export async function signHashWithPasskey(args: {
  record: PasskeyRecord;
  assert: (challenge: Uint8Array) => Promise<WebAuthnAssertion>;
  hash: Uint8Array;
  chainId: bigint;
  expectedAccount: string;
}): Promise<Uint8Array> {
  if (!same(args.record.account, args.expectedAccount)) {
    throw new Error(`The passkey belongs to ${args.record.account}, not the connected ${args.expectedAccount}. Nothing was signed.`);
  }
  if (eip155Decimal(args.record.chain) !== args.chainId) throw new Error('This passkey belongs to another network.');
  if (args.record.localStatus !== 'installed') throw new Error('This passkey is not installed.');
  return signErc1271WithPasskey(
    {
      assert: args.assert,
      publicKey: recordPublicKey(args.record),
      usePrecompiled: args.record.usePrecompiled,
      validator: args.record.validator,
    },
    args.hash,
    { chainId: args.chainId, account: args.record.account },
  );
}

/** A display label for the passkey user entry in the OS password manager (no personal data). */
export function passkeyUserName(accountName: string, account: string, networkLabel: string): string {
  return `${accountName} · ${account.slice(0, 6)}…${account.slice(-4)} · ${networkLabel}`;
}

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
import { encodeFunctionCall, encodeSequence } from './abi.js';
import { keccak, toBytes, toHex, toWord } from './encoding.js';
import {
  encodeKernelExecute,
  kernelErc1271Digest,
  kernelValidatorId,
} from './kernel-account.js';
import type { JsonRpcTransport } from './rpc.js';
import type {
  Call,
  SmartAccountSignatureContext,
  SmartAccountSpec,
  UserOpSigningContext,
} from './smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash } from './userop.js';

/**
 * Passkey (WebAuthn, P-256) signer for Kernel v3.3 through ZeroDev's
 * WebAuthnValidator, installed as an ADDITIONAL validator on a Kernel account
 * whose ROOT validator stays the seed-derived ECDSA owner (ADR D1: the seed
 * phrase remains the recovery root; the account address, which depends only
 * on the root owner and the index, is unchanged by installing a passkey).
 *
 * Every fact below was taken from primary sources fetched 2026-10-01:
 *
 *  [V] Deployed validator source. WebAuthnValidator v0.0.3 ("PATCHED" in the
 *      SDK) at 0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69: Sourcify "match"
 *      (partial: creation and runtime bytecode match, metadata differs) on
 *      Sepolia, sourcify.dev/server/v2/contract/11155111/0x7ab16F…9e69
 *      (solc 0.8.30, via-IR, runs 20000, evmVersion london; deployed in
 *      Sepolia tx 0x8bf42851…4913, block 9229299). Mainnet has no Sourcify
 *      record, but eth_getCode returns IDENTICAL runtime code on both chains
 *      (4,739 bytes, keccak256 0x726d987a…9c9eea, read 2026-10-01 from
 *      ethereum.publicnode.com and ethereum-sepolia-rpc.publicnode.com).
 *      The verified logic equals github.com/zerodevapp/kernel-7579-plugins
 *      commit e418592b (2025-11-04) src/validators/webauthn/WebAuthnValidator.sol
 *      and src/utils/{WebAuthn,P256,Base64URL}.sol except for import paths;
 *      the repository README at db37cbc5 (2026-01-09) lists this address as
 *      "Webauthn Validator".
 *  [K] github.com/zerodevapp/kernel tag v3.3, commit cd697c7e
 *      (src/Kernel.sol validateUserOp / installModule / uninstallValidation /
 *      grantAccess, src/core/ValidationManager.sol _installValidation /
 *      _validateUserOp / _verifySignature / _clearValidationData,
 *      src/utils/ValidationTypeLib.sol encodeAsNonceKey / decodeNonce /
 *      decodeSignature, src/types/Structs.sol InstallValidatorDataFormat).
 *  [S] github.com/zerodevapp/sdk commit cd7c05b5: plugins/passkey
 *      (toPasskeyValidator.ts, index.ts kernelVersionRangeToContractVersionToValidator),
 *      plugins/webauthn-key (utils.ts parseAndNormalizeSig, findQuoteIndices,
 *      base64FromUint8Array; toWebAuthnKey.ts authenticatorIdHash). The npm
 *      packages @zerodev/passkey-validator 5.6.0 and @zerodev/webauthn-key
 *      5.5.0 are byte-identical to that commit (diffed), and the tests pin
 *      their output.
 *  [P] P-256 verification. RIP-7212 (ethereum/RIPs RIPS/rip-7212.md, Final):
 *      P256VERIFY at 0x100, input hash || r || s || x || y (160 bytes), output
 *      32-byte 1 on success and EMPTY on failure, 3,450 gas. EIP-7951 (Final,
 *      eips.ethereum.org/EIPS/eip-7951) supersedes it on Ethereum L1 with the
 *      same address and interface, 6,900 gas, plus point-at-infinity and
 *      modular-comparison fixes; it shipped in Fusaka (EIP-7607): Sepolia
 *      2025-10-14, mainnet 2025-12-03. VERIFIED ON-CHAIN 2026-10-01 on both
 *      Sepolia and mainnet: eth_call to 0x100 with a valid noble-generated
 *      signature returned 0x…01, with a corrupted one returned 0x. ERC-7562
 *      (ethereum/ERCs ERCS/erc-7562.md at 583335b7) rule OP-062 allows the
 *      EIP-7951 P256VERIFY precompile during validation.
 *
 * How the validator verifies (all [V]):
 *  - onInstall(bytes data): abi.decode(data, ((uint256 x, uint256 y), bytes32))
 *    — the bytes32 is the SDK's authenticatorIdHash, decoded and IGNORED by
 *    v0.0.3; reverts InvalidPublicKey if x or y is 0 and AlreadyInitialized
 *    if the account already has a key, i.e. ONE passkey per account per
 *    validator contract. The key is stored as webAuthnValidatorStorage[account].
 *    (It does not check that (x, y) is on the curve; the engine does.)
 *  - validateUserOp: the userOp.signature is
 *    abi.encode(bytes authenticatorData, string clientDataJSON,
 *    uint256 responseTypeLocation, uint256 r, uint256 s, bool usePrecompiled)
 *    and the challenge is the RAW 32-byte userOpHash (no EIP-191 prefix).
 *    isValidSignatureWithSender uses the same envelope over the hash Kernel
 *    passes, which for ERC-1271 is Kernel's EIP-712 "Kernel(bytes32 hash)"
 *    wrapper [K _verifySignature → _toWrappedHash].
 *  - WebAuthn.verifySignature: authenticatorData length >= 37 and flags UP
 *    (0x01) and UV (0x04) set (requireUserVerification is hard-coded true),
 *    BS (0x10) only with BE (0x08); clientDataJSON contains
 *    "type":"webauthn.get" at responseTypeLocation and
 *    "challenge":"<base64url(challenge), no padding>" at the FIXED offset 23
 *    (CHALLENGE_LOCATION), so the JSON must begin exactly with
 *    {"type":"webauthn.get","challenge":" ; the signed message is
 *    sha256(authenticatorData || sha256(clientDataJSON)); s must be <= n/2
 *    (P256.verifySignature rejects high s); usePrecompiled selects 0x100,
 *    otherwise Daimo's P256Verifier at 0xc2b78104907F722DABAc4C69f826a522B2754De4
 *    (code present and identical on Sepolia and mainnet, keccak256
 *    0x3cd725b6…b7fc). The origin, rpIdHash, signature counter and backup
 *    state are NOT checked on-chain.
 *  - responseTypeLocation == type(uint256).max marks a dummy signature: the
 *    v0.0.3 code runs the P-256 check for gas and then returns false. The
 *    earlier deployments 0.0.1 (0xD990393C…Aa06) and 0.0.2 (0xbA45a2BF…90Fd),
 *    Sourcify-verified on mainnet, RETURN the P-256 result on that path while
 *    skipping the flag, type and challenge checks, so any old assertion by the
 *    same passkey would validate any operation. This engine therefore pins
 *    v0.0.3 and verifies its code hash; never use the older addresses.
 *
 * AUDIT STATUS (as published): the v3.1 incremental audit in the kernel
 * repository (audits/v_3_1_incremental_audit.pdf, uploaded in commit 737db312,
 * audit period 2024-05-27 to 2024-06-09) lists "WebAuthn Validator,
 * WebAuthnValidator.sol, commit ae10aa0f" in scope and reports no WebAuthn
 * finding. Commit ae10aa0f (kernel-7579-plugins) is the UNPATCHED code with
 * the dummy-signature behaviour above. The patched v0.0.3 differs from it in
 * that branch and in the registration event; no published audit covering the
 * patch was found. Kalos' "WebAuthn/P256 Plugin" report (2024-02-22,
 * audits/kalos_webauthn_v1.pdf) covers the Kernel v2 P256Validator in
 * zerodevapp/kernel-plugins, not this contract. Treat v0.0.3 as UNAUDITED
 * for mainnet purposes (adds to C1).
 *
 * Rights and ADR D1. Kernel lets a non-root validator act only on selectors
 * granted to it [K validateUserOp: allowedSelectors[vId][callData[0:4]]].
 * Granting execute(bytes32,bytes) makes the passkey a full co-owner: execute
 * can call the account itself, and self-calls pass onlyEntryPointOrSelfOrRoot
 * (installValidations, uninstallValidation, changeRootValidator,
 * invalidateNonce, upgradeTo …). Any installed validator can also produce
 * ERC-1271 signatures for the account (no selector check on that path [K
 * _verifySignature]). The seed's root validator can always remove the passkey
 * (uninstallValidation) or revoke every non-root validator at once
 * (invalidateNonce), but a STOLEN passkey could likewise evict the seed via
 * changeRootValidator. The spec below refuses, locally, any passkey-signed
 * call to the account itself, so this wallet never lets a passkey touch
 * account management; that is a client-side guard, not an on-chain one. An
 * on-chain guarantee needs a hook installed with the passkey validator that
 * blocks self-calls — none audited and deployed was found.
 */

/** Pinned WebAuthnValidator v0.0.3 deployment (same address and code on Ethereum mainnet and Sepolia). */
export const KERNEL_WEBAUTHN_VALIDATOR = {
  address: '0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69',
  /** SDK PasskeyValidatorContractVersion.V0_0_3_PATCHED [S plugins/passkey/index.ts]. */
  version: '0.0.3',
  /** keccak256 of the runtime code observed on both chains (2026-10-01). */
  runtimeCodeHash: '0x726d987ac55574f77f5184326631c5c51142f94c16c9b9281b751f97519c9eea',
  /** CHALLENGE_LOCATION in WebAuthnValidator.sol [V]. */
  challengeLocation: 23,
} as const;

/** P256VERIFY precompile address (RIP-7212 / EIP-7951) [P]. */
export const P256_VERIFY_PRECOMPILE = '0x0000000000000000000000000000000000000100';
/** Daimo P256Verifier used by the validator when usePrecompiled is false [V P256.sol]. */
export const DAIMO_P256_VERIFIER = '0xc2b78104907F722DABAc4C69f826a522B2754De4';
/** P-256 group order n (noble's curve parameter). */
export const P256_N: bigint = p256.Point.Fn.ORDER;
/** n / 2 (floor), the largest s the validator accepts [V P256.sol P256_N_DIV_2]. */
export const P256_HALF_N: bigint = P256_N / 2n;

/** The exact prefix the validator's fixed challenge offset (23) requires. */
export const WEBAUTHN_CLIENT_DATA_PREFIX = '{"type":"webauthn.get","challenge":"';
/** Offset of "type":"webauthn.get" in a clientDataJSON that starts with the prefix above. */
export const WEBAUTHN_RESPONSE_TYPE_LOCATION = 1n;
/** responseTypeLocation value the validator treats as a dummy signature [V]. */
export const WEBAUTHN_DUMMY_RESPONSE_TYPE_LOCATION = (1n << 256n) - 1n;

/** WebAuthn authenticator-data flag bits (W3C WebAuthn §6.1, as checked by [V] checkAuthFlags). */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

const VALIDATION_MODE_DEFAULT = 0x00;
const VALIDATION_TYPE_VALIDATOR = 0x01;
const MODULE_TYPE_VALIDATOR = 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const EXECUTE_SELECTOR = encodeFunctionCall('execute(bytes32,bytes)', []).slice(0, 4);

/**
 * SubjectPublicKeyInfo DER prefix for an uncompressed P-256 key: SEQUENCE {
 * SEQUENCE { OID id-ecPublicKey 1.2.840.10045.2.1, OID secp256r1
 * 1.2.840.10045.3.1.7 }, BIT STRING (0 unused bits) } (RFC 5480 §2.1.1 and
 * §2.2), followed by 0x04 || x || y. This is what Android's
 * AuthenticatorAttestationResponse.getPublicKey() and the WebAuthn
 * getPublicKey() browser API return for ES256 credentials.
 */
const P256_SPKI_PREFIX = toBytes('0x3059301306072a8648ce3d020106082a8648ce3d030107034200');

// ---------------------------------------------------------------------------
// Keys and install data
// ---------------------------------------------------------------------------

export interface P256PublicKey {
  x: bigint;
  y: bigint;
}

/** Validates (x, y) as a point on P-256 (not infinity) and returns it. */
export function assertP256PublicKey(key: P256PublicKey): P256PublicKey {
  if (key.x <= 0n || key.y <= 0n) throw new Error('P-256 public key coordinates must be non-zero');
  try {
    p256.Point.fromBytes(p256PublicKeyToSec1(key)).assertValidity();
  } catch {
    throw new Error('P-256 public key is not a valid curve point');
  }
  return key;
}

/** 0x04 || x || y (SEC1 uncompressed). */
export function p256PublicKeyToSec1(key: P256PublicKey): Uint8Array {
  return concatBytes(new Uint8Array([0x04]), toWord(key.x), toWord(key.y));
}

/** Parses a SEC1 public key (65-byte uncompressed or 33-byte compressed) and checks it is on the curve. */
export function p256PublicKeyFromSec1(bytes: Uint8Array): P256PublicKey {
  let point;
  try {
    point = p256.Point.fromBytes(bytes);
    point.assertValidity();
  } catch {
    throw new Error('Not a valid SEC1-encoded P-256 public key');
  }
  const affine = point.toAffine();
  return { x: affine.x, y: affine.y };
}

/** Parses a DER SubjectPublicKeyInfo holding an uncompressed P-256 key (RFC 5480). */
export function p256PublicKeyFromSpki(der: Uint8Array): P256PublicKey {
  if (der.length !== P256_SPKI_PREFIX.length + 65) {
    throw new Error(`Expected a ${P256_SPKI_PREFIX.length + 65}-byte P-256 SubjectPublicKeyInfo, got ${der.length} bytes`);
  }
  for (let i = 0; i < P256_SPKI_PREFIX.length; i++) {
    if (der[i] !== P256_SPKI_PREFIX[i]) {
      throw new Error('SubjectPublicKeyInfo is not an uncompressed P-256 (secp256r1) key');
    }
  }
  return p256PublicKeyFromSec1(der.slice(P256_SPKI_PREFIX.length));
}

/**
 * keccak256 of the raw credential id, as the ZeroDev SDK computes
 * authenticatorIdHash [S toWebAuthnKey.ts]. v0.0.3 ignores it on-chain;
 * it is kept in the install data only for layout parity with the SDK.
 */
export function webAuthnAuthenticatorIdHash(credentialId: Uint8Array): Uint8Array {
  if (credentialId.length === 0) throw new Error('Credential id must not be empty');
  return keccak(credentialId);
}

/**
 * Validator install data: abi.encode((uint256 x, uint256 y), bytes32
 * authenticatorIdHash) — 96 bytes [V onInstall; S getEnableData].
 */
export function encodeWebAuthnValidatorData(key: P256PublicKey, authenticatorIdHash: Uint8Array): Uint8Array {
  assertP256PublicKey(key);
  if (authenticatorIdHash.length !== 32) throw new Error('authenticatorIdHash must be 32 bytes');
  return encodeSequence([
    {
      kind: 'tuple',
      items: [
        { kind: 'uint256', value: key.x },
        { kind: 'uint256', value: key.y },
      ],
    },
    { kind: 'fixedBytes', value: authenticatorIdHash },
  ]);
}

// ---------------------------------------------------------------------------
// Signature envelope
// ---------------------------------------------------------------------------

/**
 * One WebAuthn assertion as a platform authenticator returns it
 * (navigator.credentials.get, Android Credential Manager, iOS
 * ASAuthorizationPlatformPublicKeyCredentialAssertion).
 */
export interface WebAuthnAssertion {
  /** response.authenticatorData, raw bytes (>= 37). */
  authenticatorData: Uint8Array;
  /** response.clientDataJSON decoded to a string, byte-for-byte as signed (UTF-8). */
  clientDataJSON: string;
  /** response.signature: the ASN.1 DER ECDSA signature (ES256). */
  signature: Uint8Array;
  /** Optional: rawId, only for the caller's own bookkeeping. */
  credentialId?: Uint8Array;
}

export interface WebAuthnSignatureParts {
  authenticatorData: Uint8Array;
  clientDataJSON: string;
  responseTypeLocation: bigint;
  r: bigint;
  s: bigint;
  usePrecompiled: boolean;
}

/**
 * abi.encode(bytes, string, uint256, uint256, uint256, bool) — the exact
 * tuple WebAuthnValidator decodes [V _verifySignature; S toPasskeyValidator.ts].
 * A string is ABI-encoded like bytes (its UTF-8 bytes).
 */
export function encodeWebAuthnSignature(parts: WebAuthnSignatureParts): Uint8Array {
  return encodeSequence([
    { kind: 'bytes', value: parts.authenticatorData },
    { kind: 'bytes', value: utf8ToBytes(parts.clientDataJSON) },
    { kind: 'uint256', value: parts.responseTypeLocation },
    { kind: 'uint256', value: parts.r },
    { kind: 'uint256', value: parts.s },
    { kind: 'uint256', value: parts.usePrecompiled ? 1n : 0n },
  ]);
}

/** RFC 4648 §5 base64url without padding (what WebAuthn puts in clientDataJSON.challenge). */
export function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += alphabet[b0 >> 2]!;
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    if (i + 1 < bytes.length) out += alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    if (i + 2 < bytes.length) out += alphabet[b2 & 0x3f]!;
  }
  return out;
}

/** The challenge a passkey must sign for `digest`: base64url(digest), no padding [V Base64URL.encode]. */
export function webAuthnChallenge(digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error(`WebAuthn challenge digest must be 32 bytes, got ${digest.length}`);
  return base64UrlEncode(digest);
}

/** sha256(authenticatorData || sha256(clientDataJSON)): the message the P-256 key signs. */
export function webAuthnMessageHash(authenticatorData: Uint8Array, clientDataJSON: string): Uint8Array {
  return sha256(concatBytes(authenticatorData, sha256(utf8ToBytes(clientDataJSON))));
}

/** s -> n - s when s > n/2, as the SDK's parseAndNormalizeSig does; the validator rejects high s [V P256.sol]. */
export function normalizeP256LowS(s: bigint): bigint {
  if (s <= 0n || s >= P256_N) throw new Error('P-256 signature s is out of range');
  return s > P256_HALF_N ? P256_N - s : s;
}

/** Parses an ASN.1 DER ECDSA signature (WebAuthn ES256) into (r, s), without normalizing. */
export function parseP256DerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let sig;
  try {
    sig = p256.Signature.fromBytes(der, 'der');
  } catch {
    throw new Error('WebAuthn signature is not a valid DER-encoded P-256 ECDSA signature');
  }
  if (sig.r <= 0n || sig.r >= P256_N || sig.s <= 0n || sig.s >= P256_N) {
    throw new Error('P-256 signature r or s is out of range');
  }
  return { r: sig.r, s: sig.s };
}

export interface WebAuthnCheckOptions {
  /** When present, the signature must verify against this key (off-chain, noble p256). */
  publicKey?: P256PublicKey | undefined;
}

/**
 * Checks an assertion against everything WebAuthnValidator v0.0.3 checks,
 * BEFORE anything is submitted, and returns the envelope fields. Throws a
 * specific error for each failure:
 *  - authenticatorData shorter than 37 bytes; UP or UV flag missing; BS set
 *    without BE [V checkAuthFlags];
 *  - clientDataJSON not starting exactly with
 *    {"type":"webauthn.get","challenge":"<base64url(challenge)>" — the
 *    validator reads the challenge at the fixed offset 23 [V
 *    CHALLENGE_LOCATION], so a platform that orders the JSON differently can
 *    never produce an accepted signature, and this check fails closed;
 *  - an unparsable or out-of-range DER signature;
 *  - with options.publicKey, a signature that does not verify.
 * s is normalized to the low half (the same signature, re-expressed).
 */
export function checkWebAuthnAssertion(
  assertion: WebAuthnAssertion,
  challenge: Uint8Array,
  options: WebAuthnCheckOptions = {},
): { r: bigint; s: bigint; responseTypeLocation: bigint } {
  const authData = assertion.authenticatorData;
  if (authData.length < 37) {
    throw new Error(`authenticatorData must be at least 37 bytes, got ${authData.length}`);
  }
  const flags = authData[32]!;
  if ((flags & FLAG_UP) === 0) throw new Error('authenticatorData: user-presence (UP) flag is not set');
  if ((flags & FLAG_UV) === 0) {
    throw new Error('authenticatorData: user-verification (UV) flag is not set; request userVerification "required"');
  }
  if ((flags & FLAG_BE) === 0 && (flags & FLAG_BS) !== 0) {
    throw new Error('authenticatorData: backup-state (BS) flag set without backup-eligible (BE)');
  }
  const expectedStart = `${WEBAUTHN_CLIENT_DATA_PREFIX}${webAuthnChallenge(challenge)}"`;
  if (!assertion.clientDataJSON.startsWith(expectedStart)) {
    if (!assertion.clientDataJSON.startsWith(WEBAUTHN_CLIENT_DATA_PREFIX)) {
      throw new Error(
        'clientDataJSON must begin with {"type":"webauthn.get","challenge":" — the Kernel WebAuthn validator ' +
          'reads the challenge at a fixed offset, so this assertion can never validate on-chain',
      );
    }
    throw new Error('clientDataJSON challenge does not equal base64url(expected digest)');
  }
  const { r, s } = parseP256DerSignature(assertion.signature);
  const lowS = normalizeP256LowS(s);
  if (options.publicKey) {
    const message = webAuthnMessageHash(authData, assertion.clientDataJSON);
    const compact = concatBytes(toWord(r), toWord(lowS));
    const ok = p256.verify(compact, message, p256PublicKeyToSec1(assertP256PublicKey(options.publicKey)), {
      prehash: false,
      lowS: true,
    });
    if (!ok) throw new Error('WebAuthn signature does not verify against the registered passkey public key');
  }
  return { r, s: lowS, responseTypeLocation: WEBAUTHN_RESPONSE_TYPE_LOCATION };
}

/**
 * The validator signature for `challenge` (a userOpHash, or a Kernel
 * ERC-1271 wrapped digest) from one assertion: checked, low-s normalized,
 * ABI-encoded. `usePrecompiled` must be true only where 0x100 answers (see
 * detectP256Precompile).
 */
export function encodeWebAuthnSignatureFromAssertion(
  assertion: WebAuthnAssertion,
  challenge: Uint8Array,
  options: { usePrecompiled: boolean; publicKey?: P256PublicKey | undefined },
): Uint8Array {
  const { r, s, responseTypeLocation } = checkWebAuthnAssertion(assertion, challenge, {
    publicKey: options.publicKey,
  });
  return encodeWebAuthnSignature({
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    responseTypeLocation,
    r,
    s,
    usePrecompiled: options.usePrecompiled,
  });
}

/**
 * Gas-estimation stub: the ZeroDev SDK's stub fields verbatim [S
 * toPasskeyValidator.ts getStubSignature] (a 37-byte authenticatorData with
 * flags 0x1d, a 244-byte clientDataJSON, responseTypeLocation 1, fixed r and
 * s) but with `usePrecompiled` set to the REAL value. The SDK hard-codes
 * false (the Daimo verifier: 314k to 332k more gas per operation than the
 * precompile across eth_simulateV1 runs of scripts/testnet/passkey-smoke.mjs
 * on Sepolia, 2026-10-01), which would make a precompile-signed operation's
 * verification gas look wasteful to bundlers that enforce an efficiency
 * floor. The stub never validates (the signature does not match), so
 * bundlers see SIG_VALIDATION_FAILED, which they tolerate during estimation.
 * A real clientDataJSON longer than 244 bytes needs gas padding.
 */
export function webAuthnStubSignature(usePrecompiled: boolean): Uint8Array {
  return encodeWebAuthnSignature({
    authenticatorData: toBytes('0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000'),
    clientDataJSON:
      '{"type":"webauthn.get","challenge":"tbxXNFS9X_4Byr1cMwqKrIGB-_30a0QhZ6y7ucM0BOE","origin":"http://localhost:3000","crossOrigin":false, "other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}',
    responseTypeLocation: 1n,
    r: 44941127272049826721201904734628716258498742255959991581049806490182030242267n,
    s: 9910254599581058084911561569808925251374718953855182016200087235935345969636n,
    usePrecompiled,
  });
}

// ---------------------------------------------------------------------------
// Kernel routing, install, uninstall
// ---------------------------------------------------------------------------

/** Kernel ValidationId for the validator: 0x01 || address [K validatorToIdentifier]. */
export function webAuthnValidationId(validator: string = KERNEL_WEBAUTHN_VALIDATOR.address): Uint8Array {
  return kernelValidatorId(validator);
}

/**
 * uint192 EntryPoint nonce key routing an operation to the validator [K
 * ValidatorLib.encodeAsNonceKey; S toKernelPluginManager.ts getNonceKey]:
 * mode 0x00 (default) || type 0x01 (validator) || validator address (20
 * bytes) || parallel key (uint16).
 */
export function webAuthnNonceKey(
  validator: string = KERNEL_WEBAUTHN_VALIDATOR.address,
  options: { parallelKey?: number | undefined } = {},
): bigint {
  const parallelKey = options.parallelKey ?? 0;
  if (!Number.isInteger(parallelKey) || parallelKey < 0 || parallelKey > 0xffff) {
    throw new Error('parallelKey must be a uint16');
  }
  const key = new Uint8Array(24);
  key[0] = VALIDATION_MODE_DEFAULT;
  key[1] = VALIDATION_TYPE_VALIDATOR;
  key.set(toBytes(validator), 2);
  key[22] = parallelKey >> 8;
  key[23] = parallelKey & 0xff;
  return BigInt(toHex(key));
}

/**
 * installModule(1, validator, initData) calldata that installs the passkey
 * AND grants it execute(bytes32,bytes) in one call [K Kernel.installModule:
 * initData = hook (20 bytes) || abi.encode(InstallValidatorDataFormat
 * {bytes validatorData, bytes hookData, bytes selectorData}); hook
 * address(0) is stored as address(1) = "installed, no hook"; a 4-byte
 * selectorData is passed to _grantAccess]. Kernel computes the validation
 * nonce itself, so no state has to be read first and the call also works in
 * the same operation that deploys the account. Kernel's own tests use the
 * same layout (test/base/KernelTestBase.sol _installValidator).
 *
 * It must be executed by the ROOT (seed) validator — a self-call inside a
 * root-signed operation (see passkeyInstallCall).
 */
export function encodePasskeyInstall(
  key: P256PublicKey,
  authenticatorIdHash: Uint8Array,
  validator: string = KERNEL_WEBAUTHN_VALIDATOR.address,
): Uint8Array {
  const initData = concatBytes(
    toBytes(ZERO_ADDRESS),
    encodeSequence([
      { kind: 'bytes', value: encodeWebAuthnValidatorData(key, authenticatorIdHash) },
      { kind: 'bytes', value: new Uint8Array(0) },
      { kind: 'bytes', value: EXECUTE_SELECTOR },
    ]),
  );
  return encodeFunctionCall('installModule(uint256,address,bytes)', [
    { kind: 'uint256', value: MODULE_TYPE_VALIDATOR },
    { kind: 'address', value: validator },
    { kind: 'bytes', value: initData },
  ]);
}

/** The install as a self-call for a ROOT-signed SmartAccountClient.sendCalls (createKernelAccountSpec). */
export function passkeyInstallCall(
  account: string,
  key: P256PublicKey,
  authenticatorIdHash: Uint8Array,
  validator: string = KERNEL_WEBAUTHN_VALIDATOR.address,
): Call {
  return { to: account, value: 0n, data: encodePasskeyInstall(key, authenticatorIdHash, validator) };
}

/**
 * Root-signed removal: uninstallValidation(vId, 0x, 0x), which clears the
 * validation config (later passkey operations and ERC-1271 signatures revert
 * InvalidValidator) and calls the validator's onUninstall, deleting the stored
 * key so a new passkey can be installed later [K uninstallValidation,
 * _clearValidationData; V onUninstall]; then grantAccess(vId, execute, false),
 * because Kernel does not clear selector grants on uninstall. Do NOT use
 * uninstallModule(1, …) for this: it only clears the config and never calls
 * onUninstall, so the old key would stay stored and a reinstall would revert
 * AlreadyInitialized.
 */
export function passkeyUninstallCalls(account: string, validator: string = KERNEL_WEBAUTHN_VALIDATOR.address): Call[] {
  const vId = webAuthnValidationId(validator);
  return [
    {
      to: account,
      value: 0n,
      data: encodeFunctionCall('uninstallValidation(bytes21,bytes,bytes)', [
        { kind: 'fixedBytes', value: vId },
        { kind: 'bytes', value: new Uint8Array(0) },
        { kind: 'bytes', value: new Uint8Array(0) },
      ]),
    },
    {
      to: account,
      value: 0n,
      data: encodeFunctionCall('grantAccess(bytes21,bytes4,bool)', [
        { kind: 'fixedBytes', value: vId },
        { kind: 'fixedBytes', value: EXECUTE_SELECTOR },
        { kind: 'uint256', value: 0n },
      ]),
    },
  ];
}

// ---------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------

export interface PasskeyValidatorState {
  /** validationConfig(vId).nonce. */
  validationNonce: number;
  /** validationConfig(vId).hook: address(0) = not installed, address(1) = installed without hook. */
  hook: string;
  /** isAllowedSelector(vId, execute). */
  executeAllowed: boolean;
  /** validNonceFrom(): validators whose nonce is below it are revoked. */
  validNonceFrom: number;
  /** The key stored for this account in the validator, or null when none. */
  publicKey: P256PublicKey | null;
  /** True when a passkey operation would be routed and allowed. */
  installed: boolean;
}

/** Reads the passkey's Kernel and validator state with read-only eth_calls. */
export async function readPasskeyValidatorState(
  node: JsonRpcTransport,
  account: string,
  validator: string = KERNEL_WEBAUTHN_VALIDATOR.address,
): Promise<PasskeyValidatorState> {
  const vId = webAuthnValidationId(validator);
  const call = async (to: string, data: Uint8Array): Promise<Uint8Array> =>
    toBytes((await node('eth_call', [{ to, data: toHex(data) }, 'latest'])) as string);
  const word = (bytes: Uint8Array, index: number, what: string): bigint => {
    if (bytes.length < (index + 1) * 32) throw new Error(`${what} returned too little data`);
    return BigInt(toHex(bytes.slice(index * 32, index * 32 + 32)));
  };
  const config = await call(account, encodeFunctionCall('validationConfig(bytes21)', [{ kind: 'fixedBytes', value: vId }]));
  if (config.length !== 64) throw new Error('validationConfig() returned an unexpected shape; is this a Kernel v3 account?');
  const allowed = await call(
    account,
    encodeFunctionCall('isAllowedSelector(bytes21,bytes4)', [
      { kind: 'fixedBytes', value: vId },
      { kind: 'fixedBytes', value: EXECUTE_SELECTOR },
    ]),
  );
  const validNonceFrom = await call(account, encodeFunctionCall('validNonceFrom()', []));
  const stored = await call(
    validator,
    encodeFunctionCall('webAuthnValidatorStorage(address)', [{ kind: 'address', value: account }]),
  );
  const x = word(stored, 0, 'webAuthnValidatorStorage');
  const y = word(stored, 1, 'webAuthnValidatorStorage');
  const hook = toChecksumAddress(config.slice(44, 64));
  const validationNonce = Number(word(config, 0, 'validationConfig'));
  const from = Number(word(validNonceFrom, 0, 'validNonceFrom'));
  const executeAllowed = word(allowed, 0, 'isAllowedSelector') === 1n;
  const publicKey = x === 0n ? null : { x, y };
  return {
    validationNonce,
    hook,
    executeAllowed,
    validNonceFrom: from,
    publicKey,
    installed: hook !== ZERO_ADDRESS && executeAllowed && publicKey !== null && validationNonce >= from,
  };
}

/**
 * Read-only check of the pinned validator: runtime code hash equals the one
 * observed on mainnet and Sepolia, and isModuleType(1) is true.
 */
export async function verifyWebAuthnValidatorDeployment(
  node: JsonRpcTransport,
  validator: string = KERNEL_WEBAUTHN_VALIDATOR.address,
  expectedCodeHash: string = KERNEL_WEBAUTHN_VALIDATOR.runtimeCodeHash,
): Promise<void> {
  const code = (await node('eth_getCode', [validator, 'latest'])) as string;
  if (!code || code === '0x') throw new Error(`WebAuthn validator ${validator} has no code on this chain`);
  const hash = toHex(keccak(toBytes(code)));
  if (hash.toLowerCase() !== expectedCodeHash.toLowerCase()) {
    throw new Error(`WebAuthn validator ${validator} runtime code hash is ${hash}, expected ${expectedCodeHash}`);
  }
  const result = toBytes(
    (await node('eth_call', [
      {
        to: validator,
        data: toHex(encodeFunctionCall('isModuleType(uint256)', [{ kind: 'uint256', value: MODULE_TYPE_VALIDATOR }])),
      },
      'latest',
    ])) as string,
  );
  if (result.length !== 32 || BigInt(toHex(result)) !== 1n) {
    throw new Error(`${validator} does not report itself as a validator module`);
  }
}

/**
 * True iff the P256VERIFY precompile answers on this chain: a valid
 * signature (deterministic RFC 6979 signature from a fixed test key, made
 * with noble) must return the 32-byte word 1 and a corrupted one must
 * return empty data, exactly the RIP-7212 / EIP-7951 behaviour. Any other
 * answer (including an RPC error) is treated as "absent".
 */
export async function detectP256Precompile(node: JsonRpcTransport): Promise<boolean> {
  const secret = sha256(utf8ToBytes('shiba-wallet P256VERIFY probe key'));
  const message = sha256(utf8ToBytes('shiba-wallet P256VERIFY probe message'));
  const sig = p256.sign(message, secret, { prehash: false, lowS: true });
  const pub = p256.getPublicKey(secret, false);
  const valid = concatBytes(message, sig, pub.slice(1));
  const invalid = valid.slice();
  invalid[0] = invalid[0]! ^ 0x01;
  try {
    const ok = (await node('eth_call', [{ to: P256_VERIFY_PRECOMPILE, data: toHex(valid) }, 'latest'])) as string;
    const bad = (await node('eth_call', [{ to: P256_VERIFY_PRECOMPILE, data: toHex(invalid) }, 'latest'])) as string;
    return (
      typeof ok === 'string' &&
      ok.toLowerCase() === toHex(toWord(1n)) &&
      (bad === '0x' || bad === '')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ERC-1271 with a passkey
// ---------------------------------------------------------------------------

/**
 * The ERC-1271 signature a Kernel v3.3 account accepts for `hash` when the
 * passkey signs: 0x01 || validator || WebAuthn envelope, where the passkey's
 * challenge is Kernel's EIP-712 Kernel(bytes32 hash) wrapper under the
 * account's own domain [K _verifySignature: decodeSignature validator mode,
 * then validator.isValidSignatureWithSender(sender, _toWrappedHash(hash),
 * sig)]. Async because the passkey prompt is. Undeployed accounts cannot have
 * a passkey installed, so there is no ERC-6492 path here.
 */
export async function signErc1271WithPasskey(
  config: {
    assert: (challenge: Uint8Array) => Promise<WebAuthnAssertion>;
    publicKey: P256PublicKey;
    usePrecompiled: boolean;
    validator?: string;
  },
  hash: Uint8Array,
  context: SmartAccountSignatureContext,
): Promise<Uint8Array> {
  const digest = kernelErc1271Digest(hash, context);
  const assertion = await config.assert(digest.slice());
  const envelope = encodeWebAuthnSignatureFromAssertion(assertion, digest, {
    usePrecompiled: config.usePrecompiled,
    publicKey: config.publicKey,
  });
  return concatBytes(webAuthnValidationId(config.validator ?? KERNEL_WEBAUTHN_VALIDATOR.address), envelope);
}

// ---------------------------------------------------------------------------
// SmartAccountSpec
// ---------------------------------------------------------------------------

export interface KernelPasskeySpecConfig {
  /** The DEPLOYED Kernel v3.3 account that has this passkey installed. */
  account: string;
  /** The passkey's P-256 public key, exactly as installed. */
  publicKey: P256PublicKey;
  /**
   * The platform passkey prompt. Receives the 32-byte challenge (the
   * userOpHash) and must return one assertion whose clientDataJSON challenge
   * is base64url(challenge), with user verification required. Called only
   * from signUserOpHash, which SmartAccountClient.sendCalls invokes after gas
   * estimation (and after the final paymaster data, if any), right before
   * submission.
   */
  assert: (challenge: Uint8Array) => Promise<WebAuthnAssertion>;
  /** Whether the chain has the P256VERIFY precompile (detectP256Precompile). */
  usePrecompiled: boolean;
  chainId: bigint;
  validator?: string;
  parallelKey?: number;
  entryPoint?: string;
}

export interface KernelPasskeySpec extends SmartAccountSpec {
  validator: string;
  nonceKey: bigint;
  /**
   * The DerivedAccount to pass to SmartAccountClient as "owner". It carries
   * the passkey public key (0x04 || x || y) and the smart-account address;
   * its sign() always throws. The spec refuses any other owner, so the seed
   * key can never sign through this path.
   */
  signer: DerivedAccount;
  /** The passkey nonce key (SmartAccountSpec.getNonceKey); SmartAccountClient reads the nonce for it. */
  getNonceKey(): bigint;
  /**
   * Prompts for the passkey and returns the validator envelope. Requires the
   * signing context SmartAccountClient passes (the exact operation) and
   * refuses, before any prompt, unless: the EntryPoint and chain id are the
   * configured ones; the operation's sender is the passkey account; its nonce
   * routes to the passkey validator; it carries no factory (no deployment)
   * and no EIP-7702 authorization; its callData was produced by this spec's
   * encodeCalls (so the self-call guard ran on it); and the userOpHash
   * recomputed from the operation equals the hash being signed. After the
   * prompt, the assertion is checked like the validator checks it (flags,
   * challenge at the fixed offset, signature against publicKey) and s is
   * normalized to the low half.
   */
  signUserOpHash(owner: DerivedAccount, userOpHash: Uint8Array, context?: UserOpSigningContext): Promise<Uint8Array>;
}

/** DerivedAccount stand-in for a passkey: identifies the key, never signs. */
export function passkeySignerAccount(account: string, publicKey: P256PublicKey, chainId: bigint): DerivedAccount {
  assertP256PublicKey(publicKey);
  return {
    chainId: `eip155:${chainId}`,
    path: 'passkey',
    publicKey: p256PublicKeyToSec1(publicKey),
    address: toChecksumAddress(toBytes(account)),
    sign: () => {
      throw new Error('A passkey signs only through its platform prompt (KernelPasskeySpec.signUserOpHash)');
    },
  };
}

/**
 * A SmartAccountSpec that signs UserOperations with a passkey through the
 * WebAuthnValidator on a deployed Kernel v3.3 account:
 *   const spec = kernelPasskeySpec({ account, publicKey, assert, usePrecompiled, chainId });
 *   const client = new SmartAccountClient({ ..., spec, node, bundler });
 *   const { userOpHash, userOp } = await client.sendCalls(spec.signer, calls, fees);
 *   userOp.signature // the passkey envelope that went on the wire
 * The client takes the passkey nonce key from getNonceKey, estimates gas
 * with the stub signature (estimation cannot prompt the user), and awaits
 * signUserOpHash, which runs the passkey prompt. Calls to the account
 * itself are refused before encoding (see the D1 note at the top of this
 * file).
 */
export function kernelPasskeySpec(config: KernelPasskeySpecConfig): KernelPasskeySpec {
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.account)) throw new Error('account must be an address');
  assertP256PublicKey(config.publicKey);
  const validator = config.validator ?? KERNEL_WEBAUTHN_VALIDATOR.address;
  const entryPoint = config.entryPoint ?? ENTRYPOINT_V07;
  const nonceKey = webAuthnNonceKey(validator, { parallelKey: config.parallelKey });
  const signer = passkeySignerAccount(config.account, config.publicKey, config.chainId);
  const signerKey = toHex(signer.publicKey);
  // callData values this spec produced, i.e. that passed the self-call guard
  // in encodeCalls. signUserOpHash signs only operations carrying one of them.
  const encodedCallData = new Set<string>();
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const requireSigner = (owner: DerivedAccount): void => {
    if (toHex(owner.publicKey) !== signerKey) {
      throw new Error('This passkey spec is driven only by its own signer (spec.signer); refusing another key');
    }
  };

  return {
    validator,
    nonceKey,
    signer,

    getNonceKey(): bigint {
      return nonceKey;
    },

    async getAddress(owner: DerivedAccount): Promise<string> {
      requireSigner(owner);
      return signer.address;
    },

    async getFactoryArgs(): Promise<{ factory: string; factoryData: Uint8Array }> {
      throw new Error(`Kernel account ${config.account} is not deployed; a passkey can only be installed on a deployed account`);
    },

    encodeCalls(calls: Call[]): Uint8Array {
      for (const call of calls) {
        if (same(call.to, config.account)) {
          throw new Error(
            'A passkey may not call the account itself (account management stays with the seed owner)',
          );
        }
      }
      const callData = encodeKernelExecute(calls);
      encodedCallData.add(toHex(callData).toLowerCase());
      return callData;
    },

    async signUserOpHash(
      owner: DerivedAccount,
      userOpHash: Uint8Array,
      context?: UserOpSigningContext,
    ): Promise<Uint8Array> {
      requireSigner(owner);
      if (userOpHash.length !== 32) throw new Error('userOpHash must be 32 bytes');
      if (!context) {
        throw new Error(
          'A passkey signs only with the operation it covers (SmartAccountClient.sendCalls passes it); refusing a bare hash',
        );
      }
      if (!same(context.entryPoint, entryPoint)) throw new Error('The operation targets a different EntryPoint');
      if (context.chainId !== config.chainId) throw new Error('The operation is for a different chain');
      const op = context.userOp;
      if (!same(op.sender, config.account)) throw new Error('Operation sender is not the passkey account');
      if (op.nonce >> 64n !== nonceKey) throw new Error('Operation nonce does not route to the passkey validator');
      if (op.factory) throw new Error('A passkey operation cannot deploy the account');
      if (op.eip7702Auth) throw new Error('A passkey operation cannot carry an EIP-7702 authorization');
      if (!encodedCallData.has(toHex(op.callData).toLowerCase())) {
        throw new Error(
          "The operation's callData was not produced by this passkey spec's encodeCalls; refusing to sign",
        );
      }
      if (toHex(getUserOpHash(op, entryPoint, config.chainId)) !== toHex(userOpHash)) {
        throw new Error('The operation changed after its hash was computed; refusing to sign');
      }
      const assertion = await config.assert(userOpHash.slice());
      return encodeWebAuthnSignatureFromAssertion(assertion, userOpHash, {
        usePrecompiled: config.usePrecompiled,
        publicKey: config.publicKey,
      });
    },

    stubSignature(): Uint8Array {
      return webAuthnStubSignature(config.usePrecompiled);
    },
  };
}

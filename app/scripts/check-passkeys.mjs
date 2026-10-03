// Phase 8 item 3 (app half): the passkey signer, entirely OFFLINE. Exercises
// the exact app modules (src/wallet/passkeys.ts, aa.ts) under Node's type
// stripping against fakes:
//  - a FAKE NATIVE LAYER standing in for react-native-passkeys 0.4.2: a
//    synthetic P-256 authenticator built on Node's own crypto (OpenSSL, an
//    implementation independent of the engine's noble code) that returns
//    WebAuthn-JSON-shaped results (base64url fields; attestationObject in
//    CBOR with a COSE_Key; clientDataJSON in the WebAuthn L3 section 5.8.1.1
//    order: type, challenge, origin, crossOrigin; DER signatures), in both
//    the Android shape (publicKey = DER SubjectPublicKeyInfo) and the
//    library's iOS shape (publicKey = raw 64-byte x||y);
//  - the feature gate (Expo Go / missing native module, the rpId
//    placeholder, reserved names) and app.json ↔ config/passkey.ts agreement;
//    the lazy-import rule for the native package;
//  - decoding: strict base64url, CBOR, authenticatorData, COSE → SEC1 (incl.
//    the WebAuthn L3 section 6.5.1.1 example key), the platform-key
//    cross-check, every refusal;
//  - eligibility, install calldata equal to the engine's passkeyInstallCall
//    and to an independent ethers encoding, ROOT-signed by the owner;
//  - a passkey-signed operation: passkey nonce key, envelope decoded by
//    ethers, assertion verified by the engine's checkWebAuthnAssertion AND
//    by an independent noble p256 verify AND by Node crypto; the owner key
//    is never used on that path;
//  - wrong challenge / reordered clientDataJSON / foreign credential /
//    foreign rpId refused BEFORE anything reaches the bundler;
//  - the ERC-1271 passkey signature for dApps;
//  - removal calldata (engine and ethers) and forgetting the credential.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-passkeys.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.
//
// Fixture: scripts/fixtures/webauthn-validator-v0.0.3.runtime.hex is the
// deployed runtime code of WebAuthnValidator v0.0.3
// (0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69), as recorded by Sourcify for
// Sepolia (runtime "match"); this script checks its keccak256 against the
// engine's pinned KERNEL_WEBAUTHN_VALIDATOR.runtimeCodeHash before using it,
// so the fake node serves exactly the code the engine verifies on-chain.

import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  KERNEL_WEBAUTHN_VALIDATOR,
  P256_VERIFY_PRECOMPILE,
  checkWebAuthnAssertion,
  getUserOpHash,
  kernelErc1271Digest,
  passkeyInstallCall,
  passkeyUninstallCalls,
  selector,
  toBytes,
  toHex,
  webAuthnAuthenticatorIdHash,
  webAuthnMessageHash,
  webAuthnNonceKey,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
// noble from the repository root (the version the engine uses), as an
// independent verifier next to Node's crypto.
import { p256 } from '../../node_modules/@noble/curves/nist.js';
import { keccak_256 } from '../../node_modules/@noble/hashes/sha3.js';
import { AA_DEPOSIT_TOPUP_VERIFICATION_GAS, createAaClient, sendAa } from '../src/wallet/aa.ts';
import { PASSKEY_RP_ID, PASSKEY_RP_ID_PLACEHOLDER } from '../src/config/passkey.ts';
import {
  PASSKEYS_KEY,
  PASSKEY_7702_REFUSAL,
  PASSKEY_CANCELLED,
  PASSKEY_GATE_NOTE,
  PASSKEY_NOT_OWNER_REFUSAL,
  PASSKEY_ONE_PER_ACCOUNT_REFUSAL,
  PASSKEY_SIMPLE_REFUSAL,
  PASSKEY_UNDEPLOYED_REFUSAL,
  PASSKEY_GAS_PADDING,
  base64UrlDecode,
  buildAssertionRequest,
  buildRegistrationRequest,
  classifyPasskeyState,
  coseEs256ToSec1,
  createPasskeyBundle,
  decodeAssertionResponse,
  decodeCbor,
  decodeRegistrationResponse,
  finalizePasskeyInstall,
  finalizePasskeyRemove,
  forgetPasskey,
  installPasskey,
  isConfiguredRpId,
  loadPasskeys,
  makePasskeyAssert,
  passkeyGate,
  passkeyRecordForOwner,
  passkeyTestCalls,
  preparePasskeyCalls,
  preparePasskeyInstall,
  preparePasskeyRemove,
  readPasskeyStatus,
  reconcilePasskeyRecord,
  registerPasskey,
  removePasskey,
  resetPasskeys,
  resolvePasskeyAccount,
  savePasskeyRecord,
  sendPasskeyCalls,
  signHashWithPasskey,
} from '../src/wallet/passkeys.ts';
import { KERNEL_ACCOUNT_0, OWNER_0, TEST_MNEMONIC, decodeKernelExecute, fakeKernelNode, fromRpcOp, memoryStore } from './fakes-kernel.mjs';

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
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const abi = ethers.AbiCoder.defaultAbiCoder();
const sel = (s) => toHex(selector(s));
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const b64u = (bytes) => Buffer.from(bytes).toString('base64url'); // Node's encoder, not the engine's
const sha256 = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

const RP_ID = 'wallet.shiba-test-domain.com'; // a syntactically real domain for the fakes; never contacted
const CHAIN = 'eip155:1';
const ACCOUNT = KERNEL_ACCOUNT_0;
const VALIDATOR = KERNEL_WEBAUTHN_VALIDATOR.address;

const seed = mnemonicToSeed(TEST_MNEMONIC);
const ownerKey = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);
let ownerSignCount = 0;
const owner = { ...ownerKey, sign: (h) => { ownerSignCount += 1; return ownerKey.sign(h); } };

// ---------------------------------------------------------------------------
// Minimal CBOR ENCODER (test side, independent of the app's decoder)
// ---------------------------------------------------------------------------
function cborHead(major, n) {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function cbor(value) {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const b = [...Buffer.from(value, 'utf8')];
    return [...cborHead(3, b.length), ...b];
  }
  if (value instanceof Uint8Array) return [...cborHead(2, value.length), ...value];
  if (Array.isArray(value)) return [...cborHead(4, value.length), ...value.flatMap(cbor)];
  if (value instanceof Map) return [...cborHead(5, value.size), ...[...value].flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
  throw new Error('cbor: unsupported');
}

// ---------------------------------------------------------------------------
// Fake native layer: a synthetic platform authenticator on Node crypto
// ---------------------------------------------------------------------------
function fakeAuthenticator({ platform = 'android', rpId = RP_ID } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  const y = new Uint8Array(Buffer.from(jwk.y, 'base64url'));
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const credentialId = new Uint8Array(randomBytes(20));
  const auth = {
    x, y, spki, credentialId, privateKey, publicKeyObject: publicKey,
    calls: { create: 0, get: 0 },
    // Behaviour switches for refusal tests.
    mode: 'normal',
    lastAssertion: null,
    lastRequest: null,
    counter: 0,
    async create(request) {
      auth.calls.create += 1;
      auth.lastRequest = request;
      const flags = 0x45 | 0x08; // UP | UV | AT | BE
      const cose = new Map([[1, 2], [3, auth.mode === 'rs256' ? -257 : -7], [-1, 1], [-2, x], [-3, y]]);
      const authData = new Uint8Array([
        ...sha256(Buffer.from(auth.mode === 'wrong-rp' ? 'evil.example.com' : request.rp.id)),
        auth.mode === 'no-uv' ? 0x41 : flags,
        0, 0, 0, 0,
        ...new Uint8Array(16),
        credentialId.length >> 8, credentialId.length & 0xff,
        ...(auth.mode === 'id-mismatch' ? new Uint8Array(20).fill(7) : credentialId),
        ...cbor(cose),
      ]);
      const attestationObject = new Uint8Array(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])));
      const clientDataJSON =
        `{"type":"webauthn.create","challenge":"${auth.mode === 'reg-challenge' ? b64u(new Uint8Array(32)) : request.challenge}",` +
        `"origin":"${platform === 'android' ? 'android:apk-key-hash:AAAA' : `https://${request.rp.id}`}"}`;
      const platformKey =
        auth.mode === 'key-mismatch'
          ? b64u(new Uint8Array(publicKeyOther().spki))
          : platform === 'android'
            ? b64u(spki)
            : platform === 'ios'
              ? b64u(new Uint8Array([...x, ...y]))
              : null;
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64u(Buffer.from(clientDataJSON, 'utf8')),
          attestationObject: b64u(attestationObject),
          publicKey: platformKey,
          publicKeyAlgorithm: platform === 'android' ? -7 : undefined,
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    async get(request) {
      auth.calls.get += 1;
      auth.lastRequest = request;
      if (auth.mode === 'cancel') throw new Error('UserCancelled');
      if (auth.mode === 'null') return null;
      const challengeText = auth.mode === 'wrong-challenge' ? b64u(sha256(Buffer.from('another operation'))) : request.challenge;
      const clientDataJSON =
        auth.mode === 'reordered'
          ? `{"challenge":"${challengeText}","type":"webauthn.get","origin":"https://${rpId}","crossOrigin":false}`
          : `{"type":"webauthn.get","challenge":"${challengeText}","origin":"https://${rpId}","crossOrigin":false}`;
      auth.counter += 1;
      const authenticatorData = new Uint8Array([
        ...sha256(Buffer.from(auth.mode === 'wrong-rp' ? 'evil.example.com' : request.rpId)),
        0x05,
        0, 0, 0, auth.counter,
      ]);
      const signed = new Uint8Array([...authenticatorData, ...sha256(Buffer.from(clientDataJSON, 'utf8'))]);
      const der = new Uint8Array(nodeSign('sha256', signed, privateKey)); // ASN.1 DER by default
      const id = auth.mode === 'foreign-cred' ? new Uint8Array(20).fill(9) : credentialId;
      const result = {
        id: b64u(id),
        rawId: b64u(id),
        type: 'public-key',
        response: {
          authenticatorData: b64u(authenticatorData),
          clientDataJSON: b64u(Buffer.from(clientDataJSON, 'utf8')),
          signature: b64u(der),
          userHandle: b64u(new Uint8Array(16)),
        },
        clientExtensionResults: {},
      };
      auth.lastAssertion = { authenticatorData, clientDataJSON, der, signed };
      return result;
    },
  };
  return auth;
}
let otherKeyCache = null;
function publicKeyOther() {
  if (!otherKeyCache) {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    otherKeyCache = { spki: publicKey.export({ type: 'spki', format: 'der' }) };
  }
  return otherKeyCache;
}

// ---------------------------------------------------------------------------
// Fake node: Kernel v3.3 + WebAuthnValidator v0.0.3 + P256VERIFY + getNonce
// ---------------------------------------------------------------------------
const VALIDATOR_CODE = readFileSync(new URL('./fixtures/webauthn-validator-v0.0.3.runtime.hex', import.meta.url), 'utf8').trim();
check(
  'fixture: runtime code keccak256 equals the engine-pinned WebAuthnValidator v0.0.3 hash',
  toHex(keccak_256(toBytes(VALIDATOR_CODE))) === KERNEL_WEBAUTHN_VALIDATOR.runtimeCodeHash && toBytes(VALIDATOR_CODE).length === 4739,
);

function fakePasskeyNode({ deployed = true, rootOwner = OWNER_0, precompile = true, chainIdHex = '0x1', delegated7702 = false } = {}) {
  const codeAt = delegated7702 ? { [ACCOUNT.toLowerCase()]: true } : {};
  const base = fakeKernelNode({ chainIdHex, deployedAccounts: deployed ? new Set([ACCOUNT]) : new Set(), codeAt });
  const state = { validationNonce: 0, hook: ZERO, executeAllowed: false, validNonceFrom: 0, key: null };
  const calls = [];
  const vId = ('0x01' + VALIDATOR.slice(2)).toLowerCase();
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_getCode' && same(params[0], VALIDATOR)) return VALIDATOR_CODE;
    if (method === 'eth_getCode' && delegated7702 && same(params[0], ACCOUNT)) return '0xef0100' + KERNEL_V3_3.implementation.slice(2).toLowerCase();
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      const body = '0x' + data.slice(10);
      if (same(to, P256_VERIFY_PRECOMPILE)) {
        if (!precompile) return '0x';
        const input = toBytes(data);
        if (input.length !== 160) return '0x';
        const ok = p256.verify(input.slice(32, 96), input.slice(0, 32), new Uint8Array([4, ...input.slice(96)]), { prehash: false, lowS: false });
        return ok ? word(1) : '0x';
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('rootValidator()'))) {
        return '0x01' + KERNEL_V3_3.ecdsaValidator.slice(2).toLowerCase() + '0'.repeat(22);
      }
      if (same(to, KERNEL_V3_3.ecdsaValidator) && data.startsWith(sel('ecdsaValidatorStorage(address)'))) return pad32(rootOwner);
      if (same(to, ACCOUNT) && data.startsWith(sel('validationConfig(bytes21)'))) {
        const [id] = abi.decode(['bytes21'], body);
        const mine = id.toLowerCase() === vId;
        return abi.encode(['uint32', 'address'], [mine ? state.validationNonce : 0, mine ? state.hook : ZERO]);
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('isAllowedSelector(bytes21,bytes4)'))) {
        const [id, s] = abi.decode(['bytes21', 'bytes4'], body);
        return word(id.toLowerCase() === vId && s === sel('execute(bytes32,bytes)') && state.executeAllowed ? 1 : 0);
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('validNonceFrom()'))) return word(state.validNonceFrom);
      if (same(to, VALIDATOR) && data.startsWith(sel('webAuthnValidatorStorage(address)'))) {
        return abi.encode(['uint256', 'uint256'], state.key ? [state.key.x, state.key.y] : [0, 0]);
      }
      if (same(to, VALIDATOR) && data.startsWith(sel('isModuleType(uint256)'))) return word(1);
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) {
        const [, key] = abi.decode(['address', 'uint192'], body);
        return word((BigInt(key) << 64n) | 0n);
      }
    }
    return base(method, params);
  };
  transport.calls = calls;
  transport.state = state;
  transport.install = (key) => {
    state.validationNonce = 1;
    state.hook = '0x0000000000000000000000000000000000000001';
    state.executeAllowed = true;
    state.key = key;
  };
  transport.uninstall = () => {
    state.hook = ZERO;
    state.executeAllowed = false;
    state.key = null;
  };
  return transport;
}

/** Fake bundler returning the REAL userOpHash of what it receives; records everything. */
function hashingBundler({ receipt = { success: true, receipt: { transactionHash: '0x' + 'cd'.repeat(32) } } } = {}) {
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_supportedEntryPoints') return [ENTRYPOINT_V07];
    if (method === 'eth_estimateUserOperationGas') {
      transport.lastEstimated = params[0];
      return { callGasLimit: '0x10000', verificationGasLimit: '0x20000', preVerificationGas: '0x30000' };
    }
    if (method === 'eth_sendUserOperation') {
      transport.lastOp = params[0];
      return toHex(getUserOpHash(fromRpcOp(params[0]), ENTRYPOINT_V07, 1n));
    }
    if (method === 'eth_getUserOperationReceipt') return receipt;
    throw new Error(`fake bundler: unexpected method ${method}`);
  };
  transport.calls = calls;
  transport.sends = () => calls.filter((c) => c.method === 'eth_sendUserOperation').length;
  return transport;
}

function kernelBundle(node, bundler, accountType = 'kernel-v3.3') {
  return createAaClient({
    nodeUrl: 'https://node.invalid',
    bundlerUrl: 'https://bundler.invalid',
    factory: accountType === 'simple' ? '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985' : KERNEL_V3_3.factory,
    chainId: 1n,
    accountIndex: 0,
    accountType,
    transportFor: (url) => (url.includes('bundler') ? bundler : node),
  });
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: feature gate (Expo Go, rpId placeholder)');
// ---------------------------------------------------------------------------
{
  check('config: the shipped rpId is the .invalid placeholder', PASSKEY_RP_ID === PASSKEY_RP_ID_PLACEHOLDER && PASSKEY_RP_ID.endsWith('.invalid'));
  const appJson = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  check('app.json ios.associatedDomains carries exactly webcredentials:<the configured rpId>',
    JSON.stringify(appJson.expo.ios.associatedDomains) === JSON.stringify([`webcredentials:${PASSKEY_RP_ID}`]));
  const g1 = passkeyGate({ rpId: PASSKEY_RP_ID, nativePresent: false, platformSupported: null });
  check('Expo Go (native module missing) → refused with the development-build note', !g1.ok && g1.kind === 'native-missing' && g1.reason === PASSKEY_GATE_NOTE);
  const g2 = passkeyGate({ rpId: PASSKEY_RP_ID, nativePresent: true, platformSupported: true });
  check('development build but rpId placeholder → refused with the same note', !g2.ok && g2.kind === 'rp-id-unset' && g2.reason === PASSKEY_GATE_NOTE);
  check('the note says "development build" and "rpId"', /development build/.test(PASSKEY_GATE_NOTE) && /rpId/.test(PASSKEY_GATE_NOTE));
  const g3 = passkeyGate({ rpId: RP_ID, nativePresent: true, platformSupported: false });
  check('unsupported device → refused', !g3.ok && g3.kind === 'unsupported');
  const g4 = passkeyGate({ rpId: RP_ID, nativePresent: true, platformSupported: true });
  check('native module + configured rpId + supported → open', g4.ok && g4.rpId === RP_ID);
  check('reserved / malformed rpIds refused (.invalid, .example, .test, .localhost, localhost, bare label, URL, uppercase)',
    ['x.invalid', 'wallet.example', 'a.test', 'a.localhost', 'localhost', 'wallet', 'https://wallet.com', 'Wallet.com', ''].every((r) => !isConfiguredRpId(r)));
  check('ordinary domains accepted', ['wallet.com', 'id.wallet.co.uk', 'shiba-wallet.app'].every(isConfiguredRpId));

  // The native package must only be loaded lazily, from one file, after the
  // optional-module check (it throws at evaluation where it is missing).
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  files.push(new URL('../App.tsx', import.meta.url).pathname, new URL('../index.ts', import.meta.url).pathname);
  const importers = files.filter((f) => /['"]react-native-passkeys['"]/.test(readFileSync(f, 'utf8')));
  check('react-native-passkeys is referenced by exactly one file (wallet/passkey-native.ts)',
    importers.length === 1 && importers[0].endsWith('src/wallet/passkey-native.ts'), importers.join(', '));
  const nativeSrc = readFileSync(new URL('../src/wallet/passkey-native.ts', import.meta.url), 'utf8');
  check('…and only through a dynamic import(), after requireOptionalNativeModule',
    !/^import[^;]*['"]react-native-passkeys['"]/m.test(nativeSrc) &&
      /await import\('react-native-passkeys'\)/.test(nativeSrc) &&
      nativeSrc.indexOf('requireOptionalNativeModule(NATIVE_MODULE_NAME)') !== -1 &&
      nativeSrc.indexOf('if (!preGate.ok) return') < nativeSrc.indexOf("await import('react-native-passkeys')"));
  const screenSrc = readFileSync(new URL('../src/screens/PasskeyScreen.tsx', import.meta.url), 'utf8');
  check('Passkey screen renders the gate reason before any passkey action', /gate && !gate\.ok/.test(screenSrc) && /gate\.reason/.test(screenSrc));
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: base64url, CBOR, COSE');
// ---------------------------------------------------------------------------
{
  let rt = true;
  for (let n = 0; n < 70; n++) {
    const b = new Uint8Array(randomBytes(n));
    const d = base64UrlDecode(b64u(b));
    if (Buffer.compare(Buffer.from(d), Buffer.from(b)) !== 0) rt = false;
  }
  check('base64url decode round-trips Node\'s encoder for lengths 0..69', rt);
  const bad = ['AQ==', 'A+8', 'A/8', 'AQ ', 'A', 'AB', '_w=='];
  check('refuses padding, + and /, whitespace, bad length, non-canonical trailing bits', bad.every((t) => { try { base64UrlDecode(t); return false; } catch { return true; } }));

  // WebAuthn L3 section 6.5.1.1 example ES256 key, CTAP2 canonical CBOR.
  const specX = '65eda5a12577c2bae829437fe338701a10aaa375e1bb5b5de108de439c08551d';
  const specY = '1e52ed75701163f7f9e40ddf9f341b3dc9ba860af7e0ca7ca7e9eecd0084d19c';
  const specCose = toBytes('0xa50102032620012158 20'.replace(/ /g, '') + specX + '225820' + specY);
  const parsed = coseEs256ToSec1(specCose);
  check('WebAuthn spec example COSE_Key → SEC1 04||x||y with the spec\'s coordinates',
    toHex(parsed.sec1) === '0x04' + specX + specY && parsed.publicKey.x === BigInt('0x' + specX));
  const k = new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32).fill(1)], [-3, new Uint8Array(32).fill(2)]]);
  check('COSE off-curve point refused (engine on-curve check)', (() => { try { coseEs256ToSec1(new Uint8Array(cbor(k))); return false; } catch { return true; } })());
  const rs = new Map([[1, 3], [3, -257], [-1, new Uint8Array(256)], [-2, new Uint8Array(3)]]);
  check('COSE RSA (RS256) key refused', (() => { try { coseEs256ToSec1(new Uint8Array(cbor(rs))); return false; } catch (e) { return /unexpected parameter|kty/.test(e.message); } })());
  const p384 = new Map([[1, 2], [3, -35], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]]);
  check('COSE ES384 / P-384 key refused', (() => { try { coseEs256ToSec1(new Uint8Array(cbor(p384))); return false; } catch (e) { return /ES256/.test(e.message); } })());
  const extra = new Map([[1, 2], [2, new Uint8Array(4)], [3, -7], [-1, 1], [-2, toBytes('0x' + specX)], [-3, toBytes('0x' + specY)]]);
  check('COSE key with an extra optional parameter (kid) refused per WebAuthn 6.5.1', (() => { try { coseEs256ToSec1(new Uint8Array(cbor(extra))); return false; } catch { return true; } })());
  check('CBOR: indefinite length, tags, floats and duplicate keys refused',
    [[0x5f], [0xc0, 0x00], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0], [0xa2, 0x01, 0x00, 0x01, 0x00]].every((b) => { try { decodeCbor(new Uint8Array(b)); return false; } catch { return true; } }));
  const nested = decodeCbor(new Uint8Array(cbor(new Map([['a', [1, -2, 'x', new Uint8Array([7])]]]))));
  check('CBOR: map / array / ints / text / bytes decode', nested.value.get('a')[1] === -2 && nested.value.get('a')[2] === 'x' && nested.value.get('a')[3][0] === 7);
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: registration decoding (Android SPKI, iOS raw x||y, absent)');
// ---------------------------------------------------------------------------
{
  for (const platform of ['android', 'ios', 'none']) {
    const auth = fakeAuthenticator({ platform });
    const challenge = new Uint8Array(randomBytes(32));
    const reg = await registerPasskey(auth, { rpId: RP_ID, challenge, userId: new Uint8Array(16).fill(3), userName: 'Account 1 · 0xB67b…9a42 · Ethereum' });
    check(`${platform}: public key equals the authenticator's (Node JWK x, y)`,
      reg.publicKey.x === BigInt(toHex(auth.x)) && reg.publicKey.y === BigInt(toHex(auth.y)) && toHex(reg.sec1) === toHex(new Uint8Array([4, ...auth.x, ...auth.y])));
    check(`${platform}: credential id and cross-check format`,
      toHex(reg.credentialId) === toHex(auth.credentialId) &&
        reg.platformPublicKeyFormat === (platform === 'android' ? 'spki' : platform === 'ios' ? 'raw-xy' : 'absent') &&
        reg.attestationFormat === 'none' && reg.backupEligible);
  }
  const auth = fakeAuthenticator();
  const challenge = new Uint8Array(randomBytes(32));
  await registerPasskey(auth, { rpId: RP_ID, challenge, userId: new Uint8Array(16), userName: 'n' });
  const req = auth.lastRequest;
  check('registration request: ES256 only, platform, resident key, UV required, attestation none, rp.id = rpId',
    req.pubKeyCredParams.length === 1 && req.pubKeyCredParams[0].alg === -7 && req.authenticatorSelection.userVerification === 'required' &&
      req.authenticatorSelection.authenticatorAttachment === 'platform' && req.authenticatorSelection.residentKey === 'required' &&
      req.attestation === 'none' && req.rp.id === RP_ID && req.challenge === b64u(challenge));
  const refusals = [
    ['wrong-rp', /different relying party/],
    ['no-uv', /user-verification/],
    ['id-mismatch', /differs from rawId/],
    ['key-mismatch', /differs from the one in the attestation/],
    ['rs256', /ES256/],
    ['reg-challenge', /challenge does not match/],
  ];
  for (const [mode, pattern] of refusals) {
    const a = fakeAuthenticator();
    a.mode = mode;
    const e = await caught(() => registerPasskey(a, { rpId: RP_ID, challenge, userId: new Uint8Array(16), userName: 'n' }));
    check(`registration refused: ${mode}`, e && pattern.test(e.message), e?.message);
  }
  check('null registration result → cancelled', (await caught(async () => decodeRegistrationResponse(null, { rpId: RP_ID, challenge })))?.message === PASSKEY_CANCELLED);
  check('registration request refuses a short challenge', (() => { try { buildRegistrationRequest({ rpId: RP_ID, challenge: new Uint8Array(8), userId: new Uint8Array(4), userName: 'n' }); return false; } catch { return true; } })());
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: assertion decoding and the engine contract');
// ---------------------------------------------------------------------------
let shared;
{
  const auth = fakeAuthenticator({ platform: 'ios' });
  const reg = await registerPasskey(auth, { rpId: RP_ID, challenge: new Uint8Array(randomBytes(32)), userId: new Uint8Array(16), userName: 'n' });
  const cred = { credentialId: reg.credentialIdB64, rpId: RP_ID };
  const assert = makePasskeyAssert(auth, cred);
  const challenge = sha256(Buffer.from('a user operation hash'));
  const a = await assert(challenge);
  const req = auth.lastRequest;
  check('assertion request: raw 32-byte challenge as base64url, only the registered credential, UV required, rpId',
    req.challenge === b64u(challenge) && req.allowCredentials.length === 1 && req.allowCredentials[0].id === reg.credentialIdB64 &&
      req.userVerification === 'required' && req.rpId === RP_ID);
  check('decoded assertion: exact authenticatorData, clientDataJSON string, DER signature, credential id',
    toHex(a.authenticatorData) === toHex(auth.lastAssertion.authenticatorData) && a.clientDataJSON === auth.lastAssertion.clientDataJSON &&
      toHex(a.signature) === toHex(auth.lastAssertion.der) && toHex(a.credentialId) === toHex(auth.credentialId));
  const parts = checkWebAuthnAssertion(a, challenge, { publicKey: reg.publicKey });
  check('engine checkWebAuthnAssertion accepts it against the registered key (responseTypeLocation 1)', parts.responseTypeLocation === 1n);
  const msg = webAuthnMessageHash(a.authenticatorData, a.clientDataJSON);
  check('engine message hash = sha256(authData || sha256(clientDataJSON)) computed with Node', toHex(msg) === toHex(sha256(auth.lastAssertion.signed)));
  check('independent noble p256 verify of the (low-s) signature', p256.verify(new Uint8Array([...toBytes(word(parts.r)), ...toBytes(word(parts.s))]), msg, reg.sec1, { prehash: false }));
  check('Node crypto verifies the DER signature', nodeVerify('sha256', auth.lastAssertion.signed, auth.publicKeyObject, Buffer.from(a.signature)));
  check('a 31-byte challenge is refused before the prompt', (await caught(() => assert(new Uint8Array(31)))) !== null && auth.calls.get === 1);

  for (const [mode, pattern] of [
    ['wrong-challenge', /challenge does not equal/],
    ['reordered', /must begin with/],
  ]) {
    auth.mode = mode;
    const x = await assert(challenge);
    const e = await caught(async () => checkWebAuthnAssertion(x, challenge, { publicKey: reg.publicKey }));
    check(`engine refuses a ${mode} assertion`, e && pattern.test(e.message), e?.message);
  }
  auth.mode = 'foreign-cred';
  check('a different credential is refused by the bridge', /different passkey/.test((await caught(() => assert(challenge)))?.message ?? ''));
  auth.mode = 'wrong-rp';
  check('a different rpIdHash is refused by the bridge', /different relying party/.test((await caught(() => assert(challenge)))?.message ?? ''));
  auth.mode = 'cancel';
  check('UserCancelled → plain cancel message', (await caught(() => assert(challenge)))?.message === PASSKEY_CANCELLED);
  auth.mode = 'null';
  check('null result → plain cancel message', (await caught(() => assert(challenge)))?.message === PASSKEY_CANCELLED);
  auth.mode = 'normal';
  check('clientDataJSON with invalid UTF-8 refused', (() => {
    try {
      decodeAssertionResponse({ rawId: reg.credentialIdB64, response: { authenticatorData: b64u(new Uint8Array([...sha256(Buffer.from(RP_ID)), 5, 0, 0, 0, 1])), clientDataJSON: b64u(new Uint8Array([0x7b, 0xff, 0x7d])), signature: b64u(new Uint8Array(8)) } }, cred);
      return false;
    } catch (e) { return /UTF-8/.test(e.message); }
  })());
  check('buildAssertionRequest refuses non-32-byte challenges', (() => { try { buildAssertionRequest(new Uint8Array(33), cred); return false; } catch { return true; } })());
  shared = { auth, reg };
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: eligibility');
// ---------------------------------------------------------------------------
{
  const r = await resolvePasskeyAccount(kernelBundle(fakePasskeyNode(), hashingBundler()), OWNER_0);
  check('deployed Kernel v3.3 owned by the wallet → eligible (engine-predicted address, no passkey yet)', r.ok && r.account === ACCOUNT && !r.state.installed);
  const und = await resolvePasskeyAccount(kernelBundle(fakePasskeyNode({ deployed: false }), hashingBundler()), OWNER_0);
  check('undeployed → plain refusal', !und.ok && und.reason === PASSKEY_UNDEPLOYED_REFUSAL);
  const simple = await resolvePasskeyAccount(kernelBundle(fakePasskeyNode(), hashingBundler(), 'simple'), OWNER_0);
  check('SimpleAccount → plain refusal', !simple.ok && simple.reason === PASSKEY_SIMPLE_REFUSAL);
  const k7702 = await resolvePasskeyAccount(kernelBundle(fakePasskeyNode(), hashingBundler(), 'kernel-7702'), OWNER_0);
  check('EIP-7702 upgrade → plain refusal', !k7702.ok && k7702.reason === PASSKEY_7702_REFUSAL);
  const foreign = await resolvePasskeyAccount(kernelBundle(fakePasskeyNode({ rootOwner: '0x000000000000000000000000000000000000bEEF' }), hashingBundler()), OWNER_0);
  check('another current owner → plain refusal', !foreign.ok && foreign.reason === PASSKEY_NOT_OWNER_REFUSAL);
  const wrongChain = await resolvePasskeyAccount(kernelBundle(fakePasskeyNode({ chainIdHex: '0xaa36a7' }), hashingBundler()), OWNER_0);
  check('endpoint on another chain → refusal naming both chain ids', !wrongChain.ok && /11155111/.test(wrongChain.reason));
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: install (root-signed) and the credential record');
// ---------------------------------------------------------------------------
const store = memoryStore();
let record;
const node = fakePasskeyNode();
const bundler = hashingBundler();
const bundle = kernelBundle(node, bundler);
{
  const { reg } = shared;
  const plan = await preparePasskeyInstall(bundle, OWNER_0, ACCOUNT, reg);
  const engineCall = passkeyInstallCall(ACCOUNT, reg.publicKey, webAuthnAuthenticatorIdHash(reg.credentialId));
  check('install quote = exactly the engine passkeyInstallCall (self-call, value 0)',
    plan.quote.calls.length === 1 && same(plan.quote.calls[0].to, ACCOUNT) && plan.quote.calls[0].value === 0n && toHex(plan.quote.calls[0].data) === toHex(engineCall.data));
  // Independent encoding: installModule(1, validator, address(0) || abi.encode(validatorData, 0x, execute selector)).
  const validatorData = abi.encode(['tuple(uint256,uint256)', 'bytes32'], [[reg.publicKey.x, reg.publicKey.y], ethers.keccak256(reg.credentialId)]);
  const initData = ethers.concat([ZERO, abi.encode(['bytes', 'bytes', 'bytes'], [validatorData, '0x', sel('execute(bytes32,bytes)')])]);
  const iface = new ethers.Interface(['function installModule(uint256 moduleType, address module, bytes initData)']);
  check('install calldata = ethers installModule(1, validator, 0x00…00 || abi.encode(validatorData, 0x, execute))',
    toHex(engineCall.data) === iface.encodeFunctionData('installModule', [1, VALIDATOR, initData]));
  check('precompile detected through the fake 0x100 (noble verify) → usePrecompiled', plan.usePrecompiled === true);
  const noPre = await preparePasskeyInstall(kernelBundle(fakePasskeyNode({ precompile: false }), hashingBundler()), OWNER_0, ACCOUNT, reg);
  check('no precompile → Daimo path (usePrecompiled false)', noPre.usePrecompiled === false);
  check('validator code verified (eth_getCode of the pinned validator was read)', node.calls.some((c) => c.method === 'eth_getCode' && same(c.params[0], VALIDATOR)));

  const signsBefore = ownerSignCount;
  const result = await installPasskey({
    plan,
    registration: reg,
    chain: CHAIN,
    account: ACCOUNT,
    owner: OWNER_0,
    accountIndex: 0,
    rpId: RP_ID,
    store,
    submit: async (q) => {
      check('credential record saved BEFORE submission (status installing)', (await loadPasskeys(store)).records[0]?.localStatus === 'installing');
      return sendAa(bundle, owner, q);
    },
  });
  record = result.record;
  const op = fromRpcOp(bundler.lastOp);
  const decoded = decodeKernelExecute(op.callData);
  check('submitted op executes exactly the install call (decoded by ethers)', decoded.calls.length === 1 && decoded.calls[0].data === toHex(engineCall.data) && same(decoded.calls[0].to, ACCOUNT));
  const hash = getUserOpHash(op, ENTRYPOINT_V07, 1n);
  check('install op is ROOT-signed: ethers recovers the owner EOA; nonce key 0',
    same(ethers.recoverAddress(ethers.hashMessage(hash), toHex(op.signature)), OWNER_0) && op.nonce >> 64n === 0n && ownerSignCount === signsBefore + 1);
  const raw = store._map.get(PASSKEYS_KEY);
  const stored = JSON.parse(raw).records[`${CHAIN}|${ACCOUNT.toLowerCase()}`];
  check('record holds only public data (credential id, rpId, public key, validator, precompile flag, hashes)',
    Object.keys(stored).sort().join(',') ===
      'account,accountIndex,backupEligible,chain,createdAt,credentialId,installUserOpHash,localStatus,owner,publicKey,removeUserOpHash,rpId,usePrecompiled,validator' &&
      stored.credentialId === reg.credentialIdB64 && stored.rpId === RP_ID && stored.validator === VALIDATOR && stored.usePrecompiled === true);
  node.install(reg.publicKey);
  const fin = await finalizePasskeyInstall(bundle, record, store, { timeoutMs: 10, pollMs: 1 });
  record = fin.record;
  check('after inclusion + read-back the record is installed and the status active', record.localStatus === 'installed' && fin.status.kind === 'active');
  check('second install refused: one passkey per account', (await caught(() => preparePasskeyInstall(bundle, OWNER_0, ACCOUNT, reg)))?.message === PASSKEY_ONE_PER_ACCOUNT_REFUSAL);
  check('lookup by owner finds the record', (await passkeyRecordForOwner(CHAIN, OWNER_0, store))?.account === ACCOUNT);
  const stale = memoryStore();
  await savePasskeyRecord({ ...record, localStatus: 'installing' }, stale);
  const rec = await reconcilePasskeyRecord(node, { ...record, localStatus: 'installing' }, stale);
  check('reconcile: an "installing" record whose key the chain shows becomes installed',
    rec.record.localStatus === 'installed' && (await loadPasskeys(stale)).records[0].localStatus === 'installed');
  const other = await reconcilePasskeyRecord(fakePasskeyNode(), { ...record, localStatus: 'installing' }, stale);
  check('reconcile: nothing changes while the chain shows no passkey', other.record.localStatus === 'installing' && other.status.kind === 'none');
  check('a tampered quote is refused before submit', /not the passkey install/.test((await caught(() => installPasskey({
    plan: { ...plan, quote: { ...plan.quote, calls: [{ ...plan.quote.calls[0], to: '0x000000000000000000000000000000000000dEaD' }] } },
    registration: reg, chain: CHAIN, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, rpId: RP_ID, store: memoryStore(), submit: async () => ({ userOpHash: '0x' + '11'.repeat(32) }),
  })))?.message ?? ''));
  check('install refuses the placeholder rpId', (await caught(() => installPasskey({
    plan, registration: reg, chain: CHAIN, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, rpId: PASSKEY_RP_ID_PLACEHOLDER, store: memoryStore(), submit: async () => ({ userOpHash: '0x' + '11'.repeat(32) }),
  })))?.message === PASSKEY_GATE_NOTE);
  const failing = memoryStore();
  await caught(() => installPasskey({ plan, registration: reg, chain: CHAIN, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, rpId: RP_ID, store: failing, submit: async () => { throw new Error('RPC error -32500: AA23'); } }));
  check('bundler refusal leaves a "failed" record (on-chain status decides)', (await loadPasskeys(failing)).records[0]?.localStatus === 'failed');
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: passkey-signed operation (the owner key is never used)');
// ---------------------------------------------------------------------------
{
  const { auth } = shared;
  auth.mode = 'normal';
  const signsBefore = ownerSignCount;
  const pbundle = createPasskeyBundle(bundle, record, makePasskeyAssert(auth, record));
  const calls = passkeyTestCalls(record);
  check('test operation = one zero-value call to the owner EOA', calls.length === 1 && same(calls[0].to, OWNER_0) && calls[0].value === 0n && calls[0].data.length === 0);
  const sendsBefore = bundler.sends();
  const getsBefore = auth.calls.get;
  const quote = await preparePasskeyCalls(pbundle, calls);
  check('quote: same smart account, passkey flag, no prompt yet', quote.passkey === true && quote.sender === ACCOUNT && auth.calls.get === getsBefore);
  const est = fromRpcOp(bundler.lastEstimated);
  check('estimate used the passkey nonce key and the engine stub with usePrecompiled = true',
    est.nonce >> 64n === webAuthnNonceKey() && abi.decode(['bytes', 'string', 'uint256', 'uint256', 'uint256', 'bool'], toHex(est.signature))[5] === true);
  // The fake node answers the EntryPoint deposit read with a zero word, so
  // the deposit is below the prefund and the top-up headroom applies: the
  // quote is the padded estimate plus the headroom, in the engine's order.
  check('deposit top-up headroom applied to the quote (fake deposit below the prefund)',
    quote.depositTopUpHeadroom === AA_DEPOSIT_TOPUP_VERIFICATION_GAS);
  check('gas padding applied to the quote (verification ×1.10 plus the headroom, preVerification ×1.15) and the fee',
    quote.verificationGasLimit === (0x20000n * BigInt(PASSKEY_GAS_PADDING.verification)) / 100n + AA_DEPOSIT_TOPUP_VERIFICATION_GAS &&
      quote.preVerificationGas === (0x30000n * BigInt(PASSKEY_GAS_PADDING.preVerification)) / 100n &&
      quote.fee === (quote.callGasLimit + quote.verificationGasLimit + quote.preVerificationGas) * quote.maxFeePerGas);
  check('sendAa (owner path) refuses a passkey quote', /passkey signer/.test((await caught(() => sendAa(bundle, owner, quote)))?.message ?? ''));

  const { userOpHash, signature } = await sendPasskeyCalls(pbundle, quote);
  const op = fromRpcOp(bundler.lastOp);
  const hash = getUserOpHash(op, ENTRYPOINT_V07, 1n);
  check('one prompt, one submission, bundler hash = recomputed userOpHash', auth.calls.get === getsBefore + 1 && bundler.sends() === sendsBefore + 1 && userOpHash === toHex(hash));
  check('submitted op: sender = the smart account, nonce key = webAuthnNonceKey(validator), no factory',
    op.sender === ACCOUNT && op.nonce >> 64n === webAuthnNonceKey(VALIDATOR) && !op.factory);
  check('submitted gas = estimate padded the same way as the quote',
    op.verificationGasLimit === quote.verificationGasLimit && op.preVerificationGas === quote.preVerificationGas);
  const [authData, cdj, location, r, s, usePre] = abi.decode(['bytes', 'string', 'uint256', 'uint256', 'uint256', 'bool'], toHex(op.signature));
  check('envelope decoded by ethers: authData / clientDataJSON as signed, responseTypeLocation 1, usePrecompiled true',
    authData === toHex(auth.lastAssertion.authenticatorData) && cdj === auth.lastAssertion.clientDataJSON && location === 1n && usePre === true);
  check('clientDataJSON starts with {"type":"webauthn.get","challenge":"<base64url(userOpHash)>" (offset 23)',
    cdj.startsWith(`{"type":"webauthn.get","challenge":"${b64u(hash)}"`) && cdj.indexOf(b64u(hash)) === 36 && cdj.indexOf('"challenge"') === 23);
  check('engine checkWebAuthnAssertion accepts the submitted assertion for this userOpHash', (() => {
    try { checkWebAuthnAssertion({ authenticatorData: toBytes(authData), clientDataJSON: cdj, signature: auth.lastAssertion.der }, hash, { publicKey: { x: BigInt(record.publicKey.x), y: BigInt(record.publicKey.y) } }); return true; } catch { return false; }
  })());
  const msg = sha256(new Uint8Array([...toBytes(authData), ...sha256(Buffer.from(cdj, 'utf8'))]));
  const pub = new Uint8Array([4, ...toBytes(record.publicKey.x), ...toBytes(record.publicKey.y)]);
  check('independent noble p256 verify of the envelope (r, s) — low s as the validator requires',
    s <= p256.Point.Fn.ORDER / 2n && p256.verify(new Uint8Array([...toBytes(word(r)), ...toBytes(word(s))]), msg, pub, { prehash: false }));
  check('Node crypto verifies the authenticator\'s DER signature over the same data',
    nodeVerify('sha256', new Uint8Array([...toBytes(authData), ...sha256(Buffer.from(cdj, 'utf8'))]), createPublicKey({ key: Buffer.from(auth.spki), format: 'der', type: 'spki' }), Buffer.from(auth.lastAssertion.der)));
  check('sendPasskeyCalls returns the envelope that went on the wire (the client\'s signed userOp)', signature && toHex(signature) === toHex(op.signature));
  check('no transport routing: the passkey bundle uses the base node and bundler as they are',
    pbundle.node === bundle.node && pbundle.bundler === bundle.bundler);
  check('the bundle spec forwards the engine nonce key (getNonceKey = webAuthnNonceKey(validator))',
    typeof pbundle.spec.getNonceKey === 'function' && pbundle.spec.getNonceKey() === webAuthnNonceKey(VALIDATOR));
  {
    const getsNow = auth.calls.get;
    const e = await caught(() => pbundle.spec.signUserOpHash(pbundle.passkey.spec.signer, hash));
    check('the bundle spec refuses to sign a bare hash (no operation context), with no prompt',
      e && /bare hash/.test(e.message) && auth.calls.get === getsNow, e?.message);
    const e2 = await caught(() => pbundle.spec.signUserOpHash(pbundle.passkey.spec.signer, hash, {
      userOp: { ...op, factory: KERNEL_V3_3.factory, factoryData: new Uint8Array([1]) }, entryPoint: ENTRYPOINT_V07, chainId: 1n,
    }));
    check('the bundle spec refuses an operation that would deploy the account, with no prompt',
      e2 && /cannot deploy/.test(e2.message) && auth.calls.get === getsNow, e2?.message);
  }
  check('the OWNER key was never used on the passkey path', ownerSignCount === signsBefore);
  const passkeysSrc = readFileSync(new URL('../src/wallet/passkeys.ts', import.meta.url), 'utf8');
  check('passkeys.ts has no route to the owner key (no signWith, mnemonic, storage or secure-store import)',
    !/signWith\s*\(|loadMnemonic|from '\.\/storage|expo-secure-store/.test(passkeysSrc));

  // Refusals BEFORE anything reaches the bundler.
  for (const [mode, pattern] of [
    ['wrong-challenge', /challenge does not equal/],
    ['reordered', /must begin with/],
    ['foreign-cred', /different passkey/],
    ['cancel', /cancelled/],
  ]) {
    auth.mode = mode;
    const before = bundler.sends();
    const q = await preparePasskeyCalls(pbundle, calls);
    const e = await caught(() => sendPasskeyCalls(pbundle, q));
    check(`${mode}: refused, nothing submitted`, e && pattern.test(e.message) && bundler.sends() === before, e?.message);
  }
  auth.mode = 'normal';
  check('self-call refused (the engine\'s client-side D1 guard)', /may not call the account itself/.test((await caught(() => preparePasskeyCalls(pbundle, [{ to: ACCOUNT, value: 0n, data: new Uint8Array(0) }])))?.message ?? ''));
  check('the passkey bundle refuses to quote for another address', /own smart account/.test((await caught(() => pbundle.client.getAddress({ ...owner })))?.message ?? ''));
  check('an owner-signed quote cannot be sent through the passkey path', /not prepared for the passkey/.test((await caught(() => sendPasskeyCalls(pbundle, { ...quote, passkey: undefined })))?.message ?? ''));
  check('createPasskeyBundle refuses a record from another chain', /another network/.test((() => { try { createPasskeyBundle({ ...bundle, chainId: 11155111n }, record, async () => null); return ''; } catch (e) { return e.message; } })()));
  check('createPasskeyBundle refuses a record that is not installed', /not installed/.test((() => { try { createPasskeyBundle(bundle, { ...record, localStatus: 'failed' }, async () => null); return ''; } catch (e) { return e.message; } })()));
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: ERC-1271 signature for dApps (smart-account sessions)');
// ---------------------------------------------------------------------------
{
  const { auth } = shared;
  auth.mode = 'normal';
  const hash = toBytes(ethers.hashMessage('Sign in to example dApp'));
  const sig = await signHashWithPasskey({ record, assert: makePasskeyAssert(auth, record), hash, chainId: 1n, expectedAccount: ACCOUNT });
  check('layout: 0x01 || WebAuthn validator || envelope', sig[0] === 0x01 && same(toHex(sig.slice(1, 21)), VALIDATOR));
  const [ad, cdj, , r, s] = abi.decode(['bytes', 'string', 'uint256', 'uint256', 'uint256', 'bool'], toHex(sig.slice(21)));
  const digest = kernelErc1271Digest(hash, { chainId: 1n, account: ACCOUNT });
  check('challenge = Kernel\'s EIP-712 wrapper of the hash for this account', cdj.includes(`"challenge":"${b64u(digest)}"`));
  check('noble verifies the ERC-1271 envelope', p256.verify(new Uint8Array([...toBytes(word(r)), ...toBytes(word(s))]), sha256(new Uint8Array([...toBytes(ad), ...sha256(Buffer.from(cdj, 'utf8'))])), new Uint8Array([4, ...toBytes(record.publicKey.x), ...toBytes(record.publicKey.y)]), { prehash: false }));
  check('refused for a session bound to another account', /Nothing was signed/.test((await caught(() => signHashWithPasskey({ record, assert: makePasskeyAssert(auth, record), hash, chainId: 1n, expectedAccount: OWNER_0 })))?.message ?? ''));
  check('refused on another chain', /another network/.test((await caught(() => signHashWithPasskey({ record, assert: makePasskeyAssert(auth, record), hash, chainId: 11155111n, expectedAccount: ACCOUNT })))?.message ?? ''));
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: status, removal and forgetting');
// ---------------------------------------------------------------------------
{
  check('status: active with the record\'s key', (await readPasskeyStatus(node, ACCOUNT, record)).kind === 'active');
  check('status: "other" when this device knows no record', (await readPasskeyStatus(node, ACCOUNT, null)).kind === 'other');
  check('forget refused while installed on-chain', /still installed/.test((await caught(() => forgetPasskey({ node, chain: CHAIN, account: ACCOUNT, store })))?.message ?? ''));
  const quote = await preparePasskeyRemove(bundle, OWNER_0, ACCOUNT);
  const engineCalls = passkeyUninstallCalls(ACCOUNT);
  const iface = new ethers.Interface(['function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)', 'function grantAccess(bytes21 vId, bytes4 selector, bool allow)']);
  const vId = '0x01' + VALIDATOR.slice(2).toLowerCase();
  check('removal quote = engine passkeyUninstallCalls = ethers [uninstallValidation(vId, 0x, 0x), grantAccess(vId, execute, false)]',
    quote.calls.length === 2 && quote.calls.every((c, i) => toHex(c.data) === toHex(engineCalls[i].data) && same(c.to, ACCOUNT)) &&
      toHex(engineCalls[0].data) === iface.encodeFunctionData('uninstallValidation', [vId, '0x', '0x']) &&
      toHex(engineCalls[1].data) === iface.encodeFunctionData('grantAccess', [vId, sel('execute(bytes32,bytes)'), false]));
  const signsBefore = ownerSignCount;
  const { userOpHash, record: removing } = await removePasskey({ chain: CHAIN, account: ACCOUNT, quote, store, submit: (q) => sendAa(bundle, owner, q) });
  const op = fromRpcOp(bundler.lastOp);
  check('removal is ROOT-signed by the owner (ethers recover)', same(ethers.recoverAddress(ethers.hashMessage(getUserOpHash(op, ENTRYPOINT_V07, 1n)), toHex(op.signature)), OWNER_0) && ownerSignCount === signsBefore + 1);
  check('record marked removing with the userOpHash', removing?.localStatus === 'removing' && removing.removeUserOpHash === userOpHash);
  const early = await finalizePasskeyRemove(bundle, CHAIN, ACCOUNT, userOpHash, store, { timeoutMs: 10, pollMs: 1 });
  check('not forgotten while the chain still shows the key', !early.forgotten && (await loadPasskeys(store)).records.length === 1);
  node.uninstall();
  const done = await finalizePasskeyRemove(bundle, CHAIN, ACCOUNT, userOpHash, store, { timeoutMs: 10, pollMs: 1 });
  check('after inclusion: status none, credential details forgotten', done.forgotten && done.status.kind === 'none' && (await loadPasskeys(store)).records.length === 0);
  check('tampered removal quote refused', /not this account’s passkey removal/.test((await caught(() => removePasskey({ chain: CHAIN, account: ACCOUNT, quote: { ...quote, calls: quote.calls.slice(0, 1) }, store, submit: async () => ({ userOpHash: '0x' }) })))?.message ?? ''));
  check('classify: half-removed state is "partial"', classifyPasskeyState({ validationNonce: 1, hook: '0x0000000000000000000000000000000000000001', executeAllowed: true, validNonceFrom: 0, publicKey: null, installed: false }, null).kind === 'partial');
}

// ---------------------------------------------------------------------------
console.log('check-passkeys: store discipline');
// ---------------------------------------------------------------------------
{
  const s = memoryStore();
  await s.setItem(PASSKEYS_KEY, '{not json');
  const load = await loadPasskeys(s);
  check('corrupt JSON → empty + unreadable', load.records.length === 0 && load.unreadable);
  check('writes refused while unreadable', /could not be read/.test((await caught(() => savePasskeyRecord(record, s)))?.message ?? ''));
  await resetPasskeys(s);
  check('reset makes it writable again', (await caught(() => savePasskeyRecord(record, s))) === null && (await loadPasskeys(s)).records.length === 1);
  const raw = JSON.parse(s._map.get(PASSKEYS_KEY));
  const key = Object.keys(raw.records)[0];
  raw.records[key] = { ...raw.records[key], publicKey: { x: word(1), y: word(2) } };
  await s.setItem(PASSKEYS_KEY, JSON.stringify(raw));
  const dropped = await loadPasskeys(s);
  check('a record with an off-curve key is dropped (corrupt flag)', dropped.records.length === 0 && dropped.corrupt && !dropped.unreadable);
  raw.records[key] = { ...record, rpId: PASSKEY_RP_ID_PLACEHOLDER };
  await s.setItem(PASSKEYS_KEY, JSON.stringify(raw));
  check('a record with the placeholder rpId is dropped', (await loadPasskeys(s)).records.length === 0);
  raw.records[key] = { ...record, validator: '0xbA45a2BFb8De3D24cA9D7F1B551E14dFF5d690Fd' };
  await s.setItem(PASSKEYS_KEY, JSON.stringify(raw));
  check('a record naming another validator (e.g. the unpatched v0.0.2) is dropped', (await loadPasskeys(s)).records.length === 0);
}

console.log(`\ncheck-passkeys: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

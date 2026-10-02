import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, keccak256, solidityPacked } from 'ethers';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  KERNEL_WEBAUTHN_VALIDATOR,
  P256_HALF_N,
  P256_N,
  PASSKEY_PENDING_SIGNATURE_PREFIX,
  base64UrlEncode,
  checkWebAuthnAssertion,
  detectP256Precompile,
  encodePasskeyInstall,
  encodeWebAuthnSignatureFromAssertion,
  encodeWebAuthnValidatorData,
  kernelPasskeySpec,
  normalizeP256LowS,
  p256PublicKeyFromSec1,
  p256PublicKeyFromSpki,
  p256PublicKeyToSec1,
  passkeyInstallCall,
  passkeySignerAccount,
  passkeyUninstallCalls,
  readPasskeyValidatorState,
  signErc1271WithPasskey,
  verifyWebAuthnValidatorDeployment,
  webAuthnAuthenticatorIdHash,
  webAuthnChallenge,
  webAuthnMessageHash,
  webAuthnNonceKey,
  webAuthnStubSignature,
  type P256PublicKey,
  type WebAuthnAssertion,
} from '../src/kernel-webauthn.js';
import { kernelErc1271Digest } from '../src/kernel-account.js';
import { SmartAccountClient } from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash, type UserOperation } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/*
 * Reference vectors were produced 2026-10-01 with the ZeroDev SDK's own
 * passkey plugin — @zerodev/passkey-validator 5.6.0 (toPasskeyValidator,
 * PasskeyValidatorContractVersion.V0_0_3_PATCHED, Kernel "0.3.3", EntryPoint
 * 0.7) and @zerodev/webauthn-key 5.5.0 (parseAndNormalizeSig, base64url
 * challenge), with viem 2.57.2 (getUserOperationHash) — installed in a
 * scratchpad only. Both packages are byte-identical to github.com/zerodevapp/sdk
 * commit cd7c05b5 plugins/passkey and plugins/webauthn-key. The browser
 * WebAuthn call (@simplewebauthn/browser startAuthentication) was replaced by
 * a stub that signs with the fixed synthetic P-256 key below using noble,
 * returning a DER signature and the clientDataJSON
 * {"type":"webauthn.get","challenge":"<challenge>","origin":"https://shiba.example","crossOrigin":false};
 * a second run returned the same signature with s replaced by n - s.
 */
const SDK = {
  chainId: 11155111n,
  secret: '0x263e6b57150b681a561d2970d066a17a1404e5f1a409d3b96c8b1ec1801d6e6e',
  pubX: 0xf100c3245d362e97117cdd0bf4f60facf3a407792d9f684a96df5f82edf13ba5n,
  pubY: 0x4797914ad2e6a35d4b7c20e59cde7340014272870c1fd868bb2ce35e0757bbc0n,
  credentialId: '0x030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc',
  authenticatorIdHash: '0x04d1b47ed3b04c5ff6a0280293cb2ab55bd297c9c2e0c3449831b419285d7df2',
  authenticatorData: '0x187cbd05c3ebfc8678ea8702d34309bf0086b2d66a2cd71d3f3355fce9c48aa30500000000',
  validator: '0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69',
  enableData:
    '0xf100c3245d362e97117cdd0bf4f60facf3a407792d9f684a96df5f82edf13ba54797914ad2e6a35d4b7c20e59cde7340014272870c1fd868bb2ce35e0757bbc004d1b47ed3b04c5ff6a0280293cb2ab55bd297c9c2e0c3449831b419285d7df2',
  nonceKey: 0x17ab16ff354acb328452f1d445b3ddee9a91e9e690000n,
  userOperation: {
    sender: '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106',
    nonce: 0x17ab16ff354acb328452f1d445b3ddee9a91e9e6900000000000000000005n,
    callData: '0xe9ae5c530000000000000000000000000000000000000000000000000000000000000000',
    callGasLimit: 0x186a0n,
    verificationGasLimit: 0x61a80n,
    preVerificationGas: 0xea60n,
    maxFeePerGas: 0xb2d05e00n,
    maxPriorityFeePerGas: 0x3b9aca00n,
  },
  userOpHash: '0x16fd6d6b244a5963d05b3cfb7fd924037abdf0393b58f13edde626179712b067',
  challenge: 'Fv1tayRKWWPQWzz7f9kkA3q98Dk7WPE-3eYmF5cSsGc',
  signature:
    '0x00000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000100646d787e6095704938d230b242a2e415aebb680b35ed1197d2db505e15356f1d91642e01ce949655d957977e48d7e9c3176f59f158cad69bc55a65f1ebbce800000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000025187cbd05c3ebfc8678ea8702d34309bf0086b2d66a2cd71d3f3355fce9c48aa3050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000867b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22467631746179524b57575051577a7a3766396b6b4133713938446b375750452d3365596d46356353734763222c226f726967696e223a2268747470733a2f2f73686962612e6578616d706c65222c2263726f73734f726967696e223a66616c73657d0000000000000000000000000000000000000000000000000000',
  /** SDK getStubSignature(): note usePrecompiled = false (last head word). */
  stubSignature:
    '0x00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000001635bc6d0f68ff895cae8a288ecf7542a6a9cd555df784b73e1e2ea7e9104b1db15e9015d280cb19527881c625fee43fd3a405d5b0d199a8c8e6589a7381209e40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f47b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22746278584e465339585f3442797231634d77714b724947422d5f3330613051685a36793775634d30424f45222c226f726967696e223a22687474703a2f2f6c6f63616c686f73743a33303030222c2263726f73734f726967696e223a66616c73652c20226f746865725f6b6579735f63616e5f62655f61646465645f68657265223a22646f206e6f7420636f6d7061726520636c69656e74446174614a534f4e20616761696e737420612074656d706c6174652e205365652068747470733a2f2f676f6f2e676c2f796162506578227d000000000000000000000000',
};

const ACCOUNT = SDK.userOperation.sender;
const SIG_TYPES = ['bytes', 'string', 'uint256', 'uint256', 'uint256', 'bool'];
const coder = AbiCoder.defaultAbiCoder();
const kernelIface = new Interface([
  'function installModule(uint256 moduleType, address module, bytes initData)',
  'function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)',
  'function grantAccess(bytes21 vId, bytes4 selector, bool allow)',
  'function execute(bytes32 mode, bytes executionCalldata)',
]);
const EXECUTE_SELECTOR = kernelIface.getFunction('execute')!.selector;

/** A synthetic passkey: noble P-256 key + an authenticator that builds real-shaped assertions. */
function syntheticPasskey(secret: Uint8Array = p256.utils.randomSecretKey()) {
  const pub = p256.getPublicKey(secret, false);
  const publicKey: P256PublicKey = {
    x: BigInt(toHex(pub.slice(1, 33))),
    y: BigInt(toHex(pub.slice(33))),
  };
  const authenticatorData = toBytes(SDK.authenticatorData); // rpIdHash || flags 0x05 (UP|UV) || counter 0
  function assertion(
    challenge: Uint8Array,
    options: { flags?: number; highS?: boolean; json?: (c: string) => string; authData?: Uint8Array } = {},
  ): WebAuthnAssertion {
    const authData = (options.authData ?? authenticatorData).slice();
    if (options.flags !== undefined) authData[32] = options.flags;
    const c = base64UrlEncode(challenge);
    const clientDataJSON = options.json
      ? options.json(c)
      : `{"type":"webauthn.get","challenge":"${c}","origin":"https://shiba.example","crossOrigin":false}`;
    const message = webAuthnMessageHash(authData, clientDataJSON);
    const sig = p256.Signature.fromBytes(p256.sign(message, secret, { prehash: false, lowS: true }));
    const s = options.highS ? P256_N - sig.s : sig.s;
    return {
      authenticatorData: authData,
      clientDataJSON,
      signature: new p256.Signature(sig.r, s).toBytes('der'),
    };
  }
  return { secret, publicKey, assertion };
}

/** Independent check of an envelope: ethers ABI decode + noble P-256 verify, as the validator does. */
function independentlyVerify(envelope: Uint8Array, challenge: Uint8Array, key: P256PublicKey) {
  const [authData, clientDataJSON, typeLocation, r, s, usePrecompiled] = coder.decode(SIG_TYPES, envelope);
  const json = clientDataJSON as string;
  const expectedChallenge = Buffer.from(challenge).toString('base64url');
  expect(json.slice(23, 23 + 13 + expectedChallenge.length + 1)).toBe(`"challenge":"${expectedChallenge}"`);
  expect(json.slice(Number(typeLocation), Number(typeLocation) + 21)).toBe('"type":"webauthn.get"');
  const message = sha256(
    new Uint8Array([...toBytes(authData as string), ...sha256(new TextEncoder().encode(json))]),
  );
  expect(BigInt(s) <= P256_HALF_N).toBe(true);
  const compact = new p256.Signature(BigInt(r), BigInt(s)).toBytes('compact');
  const ok = p256.verify(compact, message, p256PublicKeyToSec1(key), { prehash: false, lowS: true });
  return { ok, usePrecompiled: usePrecompiled as boolean, flags: toBytes(authData as string)[32] };
}

describe('WebAuthn envelope pinned against the ZeroDev SDK passkey plugin', () => {
  const key = { x: SDK.pubX, y: SDK.pubY };
  const passkey = syntheticPasskey(toBytes(SDK.secret));

  it('public key, authenticatorIdHash and install data equal the SDK getEnableData', () => {
    expect(passkey.publicKey).toEqual(key);
    expect(toHex(webAuthnAuthenticatorIdHash(toBytes(SDK.credentialId)))).toBe(SDK.authenticatorIdHash);
    expect(toHex(encodeWebAuthnValidatorData(key, toBytes(SDK.authenticatorIdHash)))).toBe(SDK.enableData);
  });

  it('nonce key equals the SDK encoding for a regular validator', () => {
    expect(webAuthnNonceKey()).toBe(SDK.nonceKey);
    expect(webAuthnNonceKey(KERNEL_WEBAUTHN_VALIDATOR.address, { parallelKey: 0xbeef })).toBe(
      (SDK.nonceKey & ~0xffffn) | 0xbeefn,
    );
    expect(() => webAuthnNonceKey(undefined, { parallelKey: 0x10000 })).toThrow(/uint16/);
  });

  it('userOpHash, challenge and signature envelope are byte-identical to the SDK (usePrecompiled true on Sepolia)', () => {
    const op: UserOperation = { ...SDK.userOperation, callData: toBytes(SDK.userOperation.callData), signature: new Uint8Array(0) };
    const hash = getUserOpHash(op, ENTRYPOINT_V07, SDK.chainId);
    expect(toHex(hash)).toBe(SDK.userOpHash);
    expect(webAuthnChallenge(hash)).toBe(SDK.challenge);
    const envelope = encodeWebAuthnSignatureFromAssertion(passkey.assertion(hash), hash, {
      usePrecompiled: true,
      publicKey: key,
    });
    expect(toHex(envelope)).toBe(SDK.signature);
  });

  it('a high-s assertion is normalized to the same bytes as the SDK', () => {
    const hash = toBytes(SDK.userOpHash);
    const high = passkey.assertion(hash, { highS: true });
    expect(p256.Signature.fromBytes(high.signature, 'der').s > P256_HALF_N).toBe(true);
    expect(toHex(encodeWebAuthnSignatureFromAssertion(high, hash, { usePrecompiled: true, publicKey: key }))).toBe(
      SDK.signature,
    );
  });

  it('the stub equals the SDK stub with usePrecompiled false, and differs only in that word otherwise', () => {
    expect(toHex(webAuthnStubSignature(false))).toBe(SDK.stubSignature);
    const withPrecompile = webAuthnStubSignature(true);
    const sdkStub = toBytes(SDK.stubSignature);
    expect(withPrecompile.length).toBe(sdkStub.length);
    const diffs = [...withPrecompile].map((b, i) => (b !== sdkStub[i] ? i : -1)).filter((i) => i >= 0);
    expect(diffs).toEqual([5 * 32 + 31]);
  });
});

describe('envelope accepted by an independent decoder and verifier', () => {
  it('random keys and challenges: ethers decode + noble verify accept, flags and challenge as required', () => {
    for (let i = 0; i < 8; i++) {
      const pk = syntheticPasskey();
      const challenge = randomBytes(32);
      const envelope = encodeWebAuthnSignatureFromAssertion(pk.assertion(challenge, { highS: i % 2 === 1 }), challenge, {
        usePrecompiled: i % 3 === 0,
        publicKey: pk.publicKey,
      });
      const result = independentlyVerify(envelope, challenge, pk.publicKey);
      expect(result.ok).toBe(true);
      expect(result.usePrecompiled).toBe(i % 3 === 0);
      expect(result.flags & 0x05).toBe(0x05);
    }
  });

  it('base64url matches Node for every length 0..40', () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = randomBytes(n);
      expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});

describe('assertion checks fail closed (mirroring WebAuthnValidator v0.0.3)', () => {
  const pk = syntheticPasskey();
  const challenge = randomBytes(32);
  const check = (a: WebAuthnAssertion, c: Uint8Array = challenge) =>
    checkWebAuthnAssertion(a, c, { publicKey: pk.publicKey });

  it('accepts a well-formed assertion and reports responseTypeLocation 1', () => {
    expect(check(pk.assertion(challenge)).responseTypeLocation).toBe(1n);
  });
  it('refuses a missing UV flag, a missing UP flag, and BS without BE', () => {
    expect(() => check(pk.assertion(challenge, { flags: 0x01 }))).toThrow(/UV/);
    expect(() => check(pk.assertion(challenge, { flags: 0x04 }))).toThrow(/UP/);
    expect(() => check(pk.assertion(challenge, { flags: 0x15 }))).toThrow(/BS/);
    expect(check(pk.assertion(challenge, { flags: 0x1d })).responseTypeLocation).toBe(1n);
  });
  it('refuses authenticatorData shorter than 37 bytes', () => {
    expect(() => check(pk.assertion(challenge, { authData: new Uint8Array(36) }))).toThrow(/37/);
  });
  it('refuses a clientDataJSON whose challenge is not at offset 23', () => {
    expect(() =>
      check(pk.assertion(challenge, { json: (c) => `{"challenge":"${c}","type":"webauthn.get","origin":"x"}` })),
    ).toThrow(/fixed offset/);
    expect(() =>
      check(pk.assertion(challenge, { json: (c) => `{"type":"webauthn.create","challenge":"${c}"}` })),
    ).toThrow(/fixed offset/);
  });
  it('refuses a different challenge and a signature from another key', () => {
    expect(() => check(pk.assertion(randomBytes(32)))).toThrow(/challenge does not equal/);
    const other = syntheticPasskey();
    expect(() => check(other.assertion(challenge))).toThrow(/does not verify/);
  });
  it('refuses a non-DER signature', () => {
    const a = pk.assertion(challenge);
    expect(() => check({ ...a, signature: a.signature.slice(0, 10) })).toThrow(/DER/);
  });
  it('low-s normalization', () => {
    expect(normalizeP256LowS(P256_HALF_N)).toBe(P256_HALF_N);
    expect(normalizeP256LowS(P256_HALF_N + 1n)).toBe(P256_N - P256_HALF_N - 1n);
    expect(() => normalizeP256LowS(0n)).toThrow();
    expect(() => normalizeP256LowS(P256_N)).toThrow();
    expect(P256_N).toBe(0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n);
  });
});

describe('public keys', () => {
  it('SubjectPublicKeyInfo from Node crypto parses to the JWK coordinates', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
    const jwk = publicKey.export({ format: 'jwk' });
    const parsed = p256PublicKeyFromSpki(der);
    expect(parsed.x).toBe(BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')));
    expect(parsed.y).toBe(BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')));
  });
  it('refuses off-curve points, zero coordinates, and non-P-256 SPKI', () => {
    const pk = syntheticPasskey();
    expect(() => encodeWebAuthnValidatorData({ x: pk.publicKey.x, y: pk.publicKey.y + 1n }, new Uint8Array(32))).toThrow(
      /curve/,
    );
    expect(() => encodeWebAuthnValidatorData({ x: 0n, y: 1n }, new Uint8Array(32))).toThrow(/non-zero/);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    expect(() => p256PublicKeyFromSpki(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' })))).toThrow(
      /91-byte P-256/,
    );
    const p256Der = new Uint8Array(
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }),
    );
    p256Der[25] = p256Der[25]! ^ 0x01; // last byte of the secp256r1 OID
    expect(() => p256PublicKeyFromSpki(p256Der)).toThrow(/secp256r1/);
    const compressed = p256.getPublicKey(pk.secret, true);
    expect(p256PublicKeyFromSec1(compressed)).toEqual(pk.publicKey);
  });
});

describe('install / uninstall calldata (ethers as independent encoder)', () => {
  const key = { x: SDK.pubX, y: SDK.pubY };
  it('installModule(1, validator, address(0) || abi.encode(validatorData, 0x, execute selector))', () => {
    const initData = solidityPacked(
      ['address', 'bytes'],
      ['0x0000000000000000000000000000000000000000', coder.encode(['bytes', 'bytes', 'bytes'], [SDK.enableData, '0x', EXECUTE_SELECTOR])],
    );
    const expected = kernelIface.encodeFunctionData('installModule', [1, SDK.validator, initData]);
    expect(toHex(encodePasskeyInstall(key, toBytes(SDK.authenticatorIdHash)))).toBe(expected);
    const call = passkeyInstallCall(ACCOUNT, key, toBytes(SDK.authenticatorIdHash));
    expect(call.to).toBe(ACCOUNT);
    expect(call.value).toBe(0n);
  });
  it('uninstallValidation(0x01||validator, 0x, 0x) then grantAccess(…, execute, false)', () => {
    const vId = '0x01' + SDK.validator.slice(2).toLowerCase();
    const calls = passkeyUninstallCalls(ACCOUNT);
    expect(calls.map((c) => toHex(c.data))).toEqual([
      kernelIface.encodeFunctionData('uninstallValidation', [vId, '0x', '0x']),
      kernelIface.encodeFunctionData('grantAccess', [vId, EXECUTE_SELECTOR, false]),
    ]);
    expect(calls.every((c) => c.to === ACCOUNT && c.value === 0n)).toBe(true);
  });
});

describe('on-chain helpers with fake transports', () => {
  it('detectP256Precompile: true only for the RIP-7212/EIP-7951 answers', async () => {
    const emulate: JsonRpcTransport = async (_m, params) => {
      const data = toBytes((params[0] as { data: string }).data);
      const ok = p256.verify(
        new Uint8Array([...data.slice(32, 96)]),
        data.slice(0, 32),
        new Uint8Array([4, ...data.slice(96, 160)]),
        { prehash: false, lowS: false },
      );
      return ok ? '0x' + '00'.repeat(31) + '01' : '0x';
    };
    expect(await detectP256Precompile(emulate)).toBe(true);
    expect(await detectP256Precompile(async () => '0x')).toBe(false);
    expect(await detectP256Precompile(async () => '0x' + '00'.repeat(31) + '01')).toBe(false);
    expect(
      await detectP256Precompile(async () => {
        throw new Error('down');
      }),
    ).toBe(false);
  });

  it('readPasskeyValidatorState decodes Kernel and validator getters', async () => {
    const key = { x: SDK.pubX, y: SDK.pubY };
    const word = (v: bigint) => v.toString(16).padStart(64, '0');
    const node: JsonRpcTransport = async (_m, params) => {
      const { to, data } = params[0] as { to: string; data: string };
      const sel = data.slice(0, 10);
      const iface = new Interface([
        'function validationConfig(bytes21)',
        'function isAllowedSelector(bytes21,bytes4)',
        'function validNonceFrom()',
        'function webAuthnValidatorStorage(address)',
      ]);
      if (sel === iface.getFunction('validationConfig')!.selector) return '0x' + word(3n) + word(1n);
      if (sel === iface.getFunction('isAllowedSelector')!.selector) return '0x' + word(1n);
      if (sel === iface.getFunction('validNonceFrom')!.selector) return '0x' + word(0n);
      if (sel === iface.getFunction('webAuthnValidatorStorage')!.selector) {
        expect(to).toBe(KERNEL_WEBAUTHN_VALIDATOR.address);
        return '0x' + word(key.x) + word(key.y);
      }
      throw new Error(`unexpected ${sel}`);
    };
    const state = await readPasskeyValidatorState(node, ACCOUNT);
    expect(state).toMatchObject({ validationNonce: 3, executeAllowed: true, validNonceFrom: 0, installed: true, publicKey: key });
    expect(state.hook).toBe('0x0000000000000000000000000000000000000001');
  });

  it('verifyWebAuthnValidatorDeployment checks the pinned code hash', async () => {
    const code = '0x6001600101';
    const node = (codeHash: string): JsonRpcTransport => async (method) =>
      method === 'eth_getCode' ? code : '0x' + '00'.repeat(31) + '01';
    await expect(verifyWebAuthnValidatorDeployment(node(''), undefined, keccak256(code))).resolves.toBeUndefined();
    await expect(verifyWebAuthnValidatorDeployment(node(''))).rejects.toThrow(/code hash/);
  });
});

describe('ERC-1271 with a passkey', () => {
  it('challenge = Kernel wrapper digest; envelope = 0x01 || validator || WebAuthn signature', async () => {
    const pk = syntheticPasskey();
    const challenges: Uint8Array[] = [];
    const hash = randomBytes(32);
    const context = { chainId: 11155111n, account: ACCOUNT };
    const sig = await signErc1271WithPasskey(
      {
        publicKey: pk.publicKey,
        usePrecompiled: true,
        assert: async (c) => {
          challenges.push(c);
          return pk.assertion(c);
        },
      },
      hash,
      context,
    );
    const digest = kernelErc1271Digest(hash, context);
    expect(toHex(challenges[0]!)).toBe(toHex(digest));
    expect(toHex(sig.slice(0, 21))).toBe('0x01' + KERNEL_WEBAUTHN_VALIDATOR.address.slice(2).toLowerCase());
    expect(independentlyVerify(sig.slice(21), digest, pk.publicKey).ok).toBe(true);
  });
});

describe('kernelPasskeySpec through SmartAccountClient (fake transports)', () => {
  const fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 150_000_000n };
  const TARGET = '0x000000000000000000000000000000000000dEaD';

  function harness(options: { tamper?: boolean; badAssertion?: boolean } = {}) {
    const pk = syntheticPasskey();
    const challenges: Uint8Array[] = [];
    const spec = kernelPasskeySpec({
      account: ACCOUNT,
      publicKey: pk.publicKey,
      usePrecompiled: true,
      chainId: SDK.chainId,
      assert: async (c) => {
        challenges.push(c);
        return options.badAssertion ? pk.assertion(randomBytes(32)) : pk.assertion(c);
      },
    });
    const nonceKeys: bigint[] = [];
    const node: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_getCode') return '0x6001';
      if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data;
        const key = BigInt('0x' + data.slice(10 + 64, 10 + 128));
        nonceKeys.push(key);
        return '0x' + ((key << 64n) + 7n).toString(16).padStart(64, '0');
      }
      throw new Error(`unexpected node ${method}`);
    };
    const estimated: Array<Record<string, string>> = [];
    const sent: Array<Record<string, string>> = [];
    const rawBundler: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        estimated.push(params[0] as Record<string, string>);
        return { callGasLimit: '0x10000', verificationGasLimit: '0x30000', preVerificationGas: '0x10000' };
      }
      if (method === 'eth_sendUserOperation') {
        sent.push(params[0] as Record<string, string>);
        return '0x' + 'ab'.repeat(32);
      }
      throw new Error(`unexpected bundler ${method}`);
    };
    const routed = spec.routeBundler(rawBundler);
    const bundler: JsonRpcTransport = options.tamper
      ? async (method, params) => {
          if (method === 'eth_sendUserOperation') {
            const op = params[0] as Record<string, string>;
            return routed(method, [{ ...op, callGasLimit: '0x20000' }, ...params.slice(1)]);
          }
          return routed(method, params);
        }
      : routed;
    const client = new SmartAccountClient({ chainId: SDK.chainId, entryPoint: ENTRYPOINT_V07, bundler, node: spec.routeNode(node), spec });
    return { pk, spec, client, challenges, nonceKeys, estimated, sent };
  }

  it('routes the nonce key, estimates with the stub, asks the passkey for the userOpHash, sends a verifying envelope', async () => {
    const h = harness();
    const calls = [{ to: TARGET, value: 1n, data: new Uint8Array(0) }];
    const { userOp } = await h.client.sendCalls(h.spec.signer, calls, fees);
    expect(h.nonceKeys).toEqual([webAuthnNonceKey()]);
    expect(userOp.nonce).toBe((webAuthnNonceKey() << 64n) + 7n);
    expect(h.estimated[0]!.signature).toBe(toHex(webAuthnStubSignature(true)));
    expect(h.sent).toHaveLength(1);
    const sentOp: UserOperation = {
      ...userOp,
      signature: toBytes(h.sent[0]!.signature!),
    };
    const hash = getUserOpHash(sentOp, ENTRYPOINT_V07, SDK.chainId);
    expect(h.challenges.map(toHex)).toEqual([toHex(hash)]);
    expect(h.sent[0]!.signature!.toLowerCase().includes(PASSKEY_PENDING_SIGNATURE_PREFIX.slice(2))).toBe(false);
    const verdict = independentlyVerify(toBytes(h.sent[0]!.signature!), hash, h.pk.publicKey);
    expect(verdict.ok).toBe(true);
    expect(verdict.usePrecompiled).toBe(true);
    expect(toHex(h.spec.submittedSignature(toHex(hash))!)).toBe(h.sent[0]!.signature);
    // callData is a plain Kernel execute of the call.
    const decoded = kernelIface.decodeFunctionData('execute', h.sent[0]!.callData!);
    expect((decoded[1] as string).toLowerCase().startsWith(TARGET.toLowerCase())).toBe(true);
  });

  it('refuses an operation that changed after hashing, and never forwards it', async () => {
    const h = harness({ tamper: true });
    await expect(h.client.sendCalls(h.spec.signer, [{ to: TARGET, value: 0n, data: new Uint8Array(0) }], fees)).rejects.toThrow(
      /changed after its hash/,
    );
    expect(h.challenges).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('refuses an assertion over the wrong challenge before sending', async () => {
    const h = harness({ badAssertion: true });
    await expect(h.client.sendCalls(h.spec.signer, [{ to: TARGET, value: 0n, data: new Uint8Array(0) }], fees)).rejects.toThrow(
      /challenge does not equal/,
    );
    expect(h.sent).toHaveLength(0);
  });

  it('refuses self-calls, foreign owners and a placeholder leaking to other methods', async () => {
    const h = harness();
    expect(() => h.spec.encodeCalls([{ to: ACCOUNT.toLowerCase(), value: 0n, data: new Uint8Array(0) }])).toThrow(
      /may not call the account itself/,
    );
    const foreign = passkeySignerAccount(ACCOUNT, syntheticPasskey().publicKey, SDK.chainId);
    await expect(h.spec.getAddress(foreign)).rejects.toThrow(/refusing another key/);
    expect(() => h.spec.signer.sign(new Uint8Array(32))).toThrow(/platform prompt/);
    const placeholder = h.spec.signUserOpHash(h.spec.signer, new Uint8Array(32));
    const routed = h.spec.routeBundler(async () => 'forwarded');
    await expect(routed('eth_estimateUserOperationGas', [{ signature: toHex(placeholder) }, ENTRYPOINT_V07])).rejects.toThrow(
      /unsigned passkey placeholder/,
    );
    await expect(routed('eth_sendUserOperation', [{ signature: '0x1234' }, ENTRYPOINT_V07])).rejects.toThrow(
      /only operations signed through this passkey spec/,
    );
    await expect(h.spec.getFactoryArgs(h.spec.signer)).rejects.toThrow(/not deployed/);
  });
});

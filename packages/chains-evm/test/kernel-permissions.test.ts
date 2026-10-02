import { describe, expect, it } from 'vitest';
import {
  AbiCoder,
  Interface,
  TypedDataEncoder,
  getBytes,
  hashMessage,
  id as ethersId,
  keccak256,
  recoverAddress,
  zeroPadValue,
} from 'ethers';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
  type DerivedAccount,
} from '@shiba-wallet/core';
import {
  ERC7715_CALLS_PERMISSION_TYPE,
  Erc7715RequestError,
  KERNEL_ENABLE_TYPE_HASH,
  KERNEL_EXECUTE_SELECTOR,
  KERNEL_PASS_FLAG_SKIP_SIGNATURE,
  KERNEL_PERMISSION_MODULES,
  assertCallsAllowed,
  computePermissionId,
  createSessionKeyAccount,
  encodeCallPolicyData,
  encodeEnableModeSignature,
  encodePermissionInstall,
  encodePermissionRevoke,
  encodeRateLimitPolicyData,
  grantFromErc7715Request,
  grantToErc7715Request,
  kernelPermissionFromGrant,
  kernelSessionSpec,
  nextValidationNonce,
  parseSessionKeyGrant,
  permissionRevokeCall,
  prepareKernelPermissionInstall,
  readKernelPermissionState,
  serializeSessionKeyGrant,
  sessionNonceKey,
  sessionStubSignature,
  signPermissionEnable,
  signWithSessionKey,
  validateSessionKeyGrant,
  type SessionKeyGrant,
} from '../src/kernel-permissions.js';
import { encodeKernelExecute } from '../src/kernel-account.js';
import { SmartAccountClient } from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/*
 * Reference vectors below were produced 2026-10-01 with the ZeroDev SDK's
 * own encoders — @zerodev/permissions 5.6.3 (toPermissionValidator,
 * toECDSASigner, toCallPolicy V0_0_4, toTimestampPolicy, toGasPolicy,
 * toRateLimitPolicy; flag NOT_FOR_VALIDATE_SIG), @zerodev/sdk 5.5.10
 * (KernelV3_3AccountAbi) and viem 2.57.2 (hashTypedData, encodeFunctionData,
 * getUserOperationHash) — installed in a scratchpad only, never in this
 * repository. The enable digest and envelope use this engine's 4-byte
 * selectorData (the SDK's own enable flow sends a longer form; see
 * encodePermissionInstall). Everything else is the SDK's default behavior.
 */
const SESSION_PRIVATE_KEY = '0x0d04b3f51f6e0c7b0ccfb9aef76421285a08cba424e2a684ca1a664da32650a4';
const SESSION_ADDRESS = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
const ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SPENDER = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const FIXED = '0x000000000000000000000000000000000000dEaD';
const CHAIN_ID = 11155111n;
const NOW = 1789999000;

const pad32 = (hex: string) => zeroPadValue(hex, 32).toLowerCase();

function fullGrant(): SessionKeyGrant {
  return {
    sessionKey: SESSION_ADDRESS,
    calls: [
      { target: ACCOUNT, selector: null, valueLimit: 0n },
      { target: FIXED, selector: null, valueLimit: 1n },
      {
        target: TOKEN,
        selector: '0x095ea7b3',
        valueLimit: 0n,
        rules: [
          { condition: 'equal', offset: 0, params: [pad32(SPENDER)] },
          { condition: 'lessThanOrEqual', offset: 32, params: [pad32('0x0f4240')] },
        ],
      },
      {
        target: TOKEN,
        selector: '0xa9059cbb',
        valueLimit: 0n,
        rules: [{ condition: 'oneOf', offset: 0, params: [pad32(FIXED), pad32(SPENDER)] }],
      },
    ],
    validAfter: 1790000000,
    validUntil: 1790000600,
    gasBudgetWei: 2_000_000_000_000_000n,
    rateLimit: { count: 5, intervalSeconds: 60, startAt: 0 },
  };
}

function minimalGrant(): SessionKeyGrant {
  return {
    sessionKey: SESSION_ADDRESS,
    calls: [
      { target: ACCOUNT, selector: null, valueLimit: 0n },
      { target: FIXED, selector: null, valueLimit: 1n },
    ],
    validAfter: 0,
    validUntil: 1790000600,
  };
}

const SDK = {
  full: {
    permissionId: '0x6af0fcb0',
    validationId: '0x026af0fcb000000000000000000000000000000000',
    enableDigest: '0x9eaab6b40667ba7ec3ff30d817a66bc5326bd3ac2b4ee0fd90ed3dad2517e6df',
    nonceKeyDefault: 0x26af0fcb0000000000000000000000000000000000000n,
    nonceKeyEnable: 0x1026af0fcb0000000000000000000000000000000000000n,
    userOpHash: '0x76a564a8cc7ab2eae075b7dc42c3e2ab9aee2856584a650a3c1084ef9415448d',
    sessionSig:
      '0xffd390a96b07899be2919ffa2938f1fb60d5f225ba88eac766984434cd84f88c2f3bcf15fd28e671e86689d41b0b32256a3844c3cba95865eed9ef8b1ba66186ed1c',
    validatorDataHash: '0xbda3ffaa3698ee70151c2dc164133f7399fdbb8f1b4e4f88b7303e9d3134cba6',
    installValidationsHash: '0x04fba643f2deb53bdc23b34324bae1caded4c684bcca2add7fbd4343e518b387',
    grantAccess:
      '0xb9b82941026af0fcb0000000000000000000000000000000000000000000000000000000e9ae5c53000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001',
    uninstallHash: '0x1b53ef84259507cffd7d0a61eb59918ec47ed23b43622effaae913039eb708cb',
    enableEnvelopeHash: '0x965e5691bc3a80abe09af08a36378bb0641227a2097b2e5ec23da1222fcd669d',
  },
  minimal: {
    permissionId: '0x5dc4ffae',
    validationId: '0x025dc4ffae00000000000000000000000000000000',
    enableDigest: '0xf3a8ab94ca70fcb356e2fa05fa0de2e2de4771aa933326929911036fd1daa3ca',
    nonceKeyDefault: 0x25dc4ffae000000000000000000000000000000000000n,
    nonceKeyEnable: 0x1025dc4ffae000000000000000000000000000000000000n,
    userOpHash: '0x3e4c60bfac8ed28a7e7bdeac3f969d0304db83057f02486adb03602d68520bf9',
    sessionSig:
      '0xff635c718dc9b6da245790e7378f2d54db0f52dd095b7d15ee36dcd3aa65188b445a4a273c3686a92d2d5b0d20ccc6d466c2fae871dadd160fea3b91550956a1791c',
    validatorDataHash: '0x61240709d910fc2d03226cf2779bbfc37228efe7adb5b7854446af9516282fa2',
    installValidationsHash: '0xfe4216cb381ca1959dec333f336f401bf30e809c764ef0f56fdd738888e7d61e',
    grantAccess:
      '0xb9b82941025dc4ffae000000000000000000000000000000000000000000000000000000e9ae5c53000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001',
    uninstallHash: '0x1ae60a14dd7c009a015a7695c782868fc42a5dffa959126b780ce42ef6df1fd1',
    enableEnvelopeHash: '0xd94b00b6ee40bf684adbaf7c52183cb07477617800b6c7ce6ba341ce800eff05',
  },
};
/** The fixed stand-in owner enable signature used for the SDK envelope vector. */
const OWNER_ENABLE_SIG_VECTOR = '0x' + 'ab'.repeat(65);

const coder = AbiCoder.defaultAbiCoder();
const kernelAbi = new Interface([
  'function installValidations(bytes21[] vIds, (uint32 nonce, address hook)[] configs, bytes[] validationData, bytes[] hookData)',
  'function grantAccess(bytes21 vId, bytes4 selector, bool allow)',
  'function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)',
  'function execute(bytes32 execMode, bytes executionCalldata)',
  'function currentNonce() view returns (uint32)',
  'function validationConfig(bytes21 vId) view returns ((uint32 nonce, address hook))',
  'function permissionConfig(bytes4 pId) view returns ((bytes2 permissionFlag, address signer, bytes22[] policyData))',
  'function isAllowedSelector(bytes21 vId, bytes4 selector) view returns (bool)',
]);
const CALL_POLICY_PERMISSION_TYPE =
  'tuple(bytes1 callType, address target, bytes4 selector, uint256 valueLimit, tuple(uint8 condition, uint64 offset, bytes32[] params)[] rules)[]';

function session(): DerivedAccount {
  return createSessionKeyAccount(toBytes(SESSION_PRIVATE_KEY));
}

function owner(): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    registry,
  ).getAccount('eip155:1');
}

function install(grant: SessionKeyGrant) {
  return encodePermissionInstall(grant, {
    chainId: CHAIN_ID,
    account: ACCOUNT,
    currentNonce: 3,
    validationNonce: 0,
    now: NOW,
  });
}

describe('constants against Kernel v3.3 sources', () => {
  it('ENABLE_TYPE_HASH is keccak256 of the Enable type string', () => {
    expect(
      ethersId(
        'Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData)',
      ),
    ).toBe(KERNEL_ENABLE_TYPE_HASH);
  });

  it('execute and management selectors match the Solidity signatures', () => {
    expect(KERNEL_EXECUTE_SELECTOR).toBe(kernelAbi.getFunction('execute')!.selector);
    expect(KERNEL_EXECUTE_SELECTOR).toBe('0xe9ae5c53');
    expect(kernelAbi.getFunction('installValidations')!.selector).toBe('0x9198bdf5');
    expect(kernelAbi.getFunction('grantAccess')!.selector).toBe('0xb9b82941');
    expect(kernelAbi.getFunction('uninstallValidation')!.selector).toBe('0xe6f3d50a');
  });

  it('pins the module addresses from the ZeroDev permissions constants', () => {
    expect(KERNEL_PERMISSION_MODULES).toEqual({
      ecdsaSigner: '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF',
      callPolicy: '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2',
      timestampPolicy: '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F',
      gasPolicy: '0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23',
      rateLimitPolicy: '0xf63d4139B25c836334edD76641356c6b74C86873',
      sudoPolicy: '0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7',
    });
  });

  it('session key account derives the expected address', () => {
    expect(session().address).toBe(SESSION_ADDRESS);
  });
});

describe.each([
  ['full', fullGrant, SDK.full],
  ['minimal', minimalGrant, SDK.minimal],
] as const)('%s grant byte-identical to the ZeroDev SDK', (_name, makeGrant, sdk) => {
  it('permission id and validation id', () => {
    const inst = install(makeGrant());
    expect(toHex(inst.permissionId)).toBe(sdk.permissionId);
    expect(toHex(inst.validationId)).toBe(sdk.validationId);
  });

  it('validatorData (getEnableData)', () => {
    expect(keccak256(install(makeGrant()).validatorData)).toBe(sdk.validatorDataHash);
  });

  it('enable digest (EIP-712 Enable under the account domain)', () => {
    const inst = install(makeGrant());
    expect(inst.enable.nonce).toBe(3);
    expect(toHex(inst.enable.digest)).toBe(sdk.enableDigest);
  });

  it('installValidations and grantAccess calldata', () => {
    const inst = install(makeGrant());
    expect(keccak256(inst.installCalls[0]!.data)).toBe(sdk.installValidationsHash);
    expect(toHex(inst.installCalls[1]!.data)).toBe(sdk.grantAccess);
    expect(inst.installCalls.every((c) => c.to === ACCOUNT && c.value === 0n)).toBe(true);
  });

  it('uninstallValidation calldata', () => {
    const inst = install(makeGrant());
    expect(keccak256(encodePermissionRevoke(inst.permissionId, inst.policyCount))).toBe(sdk.uninstallHash);
  });

  it('nonce keys (default and enable mode)', () => {
    const inst = install(makeGrant());
    expect(sessionNonceKey(inst.permissionId)).toBe(sdk.nonceKeyDefault);
    expect(sessionNonceKey(inst.permissionId, { mode: 'enable' })).toBe(sdk.nonceKeyEnable);
  });

  it('session signature (0xff || EIP-191 signature) and enable envelope', () => {
    const inst = install(makeGrant());
    const op = {
      sender: ACCOUNT,
      nonce: (sessionNonceKey(inst.permissionId) << 64n) + 7n,
      callData: toBytes('0xe9ae5c53' + '00'.repeat(64)),
      callGasLimit: 100000n,
      verificationGasLimit: 500000n,
      preVerificationGas: 60000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 150000000n,
      signature: new Uint8Array(0),
    };
    const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
    expect(toHex(hash)).toBe(sdk.userOpHash);
    const sig = signWithSessionKey(session(), hash);
    expect(toHex(sig)).toBe(sdk.sessionSig);
    const envelope = encodeEnableModeSignature({
      validatorData: inst.validatorData,
      enableSignature: toBytes(OWNER_ENABLE_SIG_VECTOR),
      userOpSignature: sig,
    });
    expect(keccak256(envelope)).toBe(sdk.enableEnvelopeHash);
  });
});

describe('independent checks with ethers', () => {
  it('validatorData is abi.encode(bytes[]) of flag||module||data entries, signer last with SKIP_SIGNATURE', () => {
    const grant = fullGrant();
    const inst = install(grant);
    const [entries] = coder.decode(['bytes[]'], inst.validatorData) as unknown as [string[]];
    expect(entries.length).toBe(5);
    const modules = [
      KERNEL_PERMISSION_MODULES.callPolicy,
      KERNEL_PERMISSION_MODULES.timestampPolicy,
      KERNEL_PERMISSION_MODULES.gasPolicy,
      KERNEL_PERMISSION_MODULES.rateLimitPolicy,
      KERNEL_PERMISSION_MODULES.ecdsaSigner,
    ];
    entries.forEach((e, i) => {
      expect(e.slice(2, 6)).toBe(i === 4 ? '0002' : '0000');
      expect(('0x' + e.slice(6, 46)).toLowerCase()).toBe(modules[i]!.toLowerCase());
    });
    // Signer data = the session address (ECDSASigner reads _data[0:20]).
    expect(('0x' + entries[4]!.slice(46)).toLowerCase()).toBe(SESSION_ADDRESS.toLowerCase());
    // Call policy data decodes as Permission[].
    const [perms] = coder.decode([CALL_POLICY_PERMISSION_TYPE], '0x' + entries[0]!.slice(46)) as unknown as [
      Array<[string, string, string, bigint, Array<[bigint, bigint, string[]]>]>,
    ];
    expect(perms.length).toBe(4);
    expect(perms[0]).toEqual(['0x00', ACCOUNT, '0x00000000', 0n, []]);
    expect(perms[1]).toEqual(['0x00', FIXED, '0x00000000', 1n, []]);
    expect(perms[2]![2]).toBe('0x095ea7b3');
    expect(perms[2]![4].map((r) => [r[0], r[1], r[2]])).toEqual([
      [0n, 0n, [pad32(SPENDER)]],
      [4n, 32n, [pad32('0x0f4240')]],
    ]);
    expect(perms[3]![4][0]![0]).toBe(6n); // ONE_OF
    // Timestamp and gas data.
    expect(coder.decode(['uint48', 'uint48'], '0x' + entries[1]!.slice(46))).toEqual([1790000000n, 1790000600n]);
    expect(coder.decode(['uint128', 'bool', 'address'], '0x' + entries[2]!.slice(46))).toEqual([
      2_000_000_000_000_000n,
      false,
      '0x0000000000000000000000000000000000000000',
    ]);
    // Rate limit: packed uint48 interval || count || startAt.
    expect(entries[3]!.slice(46)).toBe('00000000003c' + '000000000005' + '000000000000');
    expect(toHex(encodeRateLimitPolicyData(60, 5, 0))).toBe('0x00000000003c000000000005000000000000');
  });

  it('permission id recomputed with ethers from the SDK formula', () => {
    const permission = kernelPermissionFromGrant(minimalGrant());
    const entry = (e: { flag: number; module: string; data: Uint8Array }) =>
      '0x' + e.flag.toString(16).padStart(4, '0') + e.module.slice(2) + toHex(e.data).slice(2);
    const policyId = coder.encode(['bytes[]'], [permission.policies.map(entry)]);
    const signerId = coder.encode(['bytes'], [permission.signer.module + toHex(permission.signer.data).slice(2)]);
    const expected = keccak256(coder.encode(['bytes[]'], [[policyId, '0x0002', signerId]])).slice(0, 10);
    expect(toHex(computePermissionId(permission))).toBe(expected);
  });

  it('enable digest equals ethers TypedDataEncoder over the Kernel domain', () => {
    const inst = install(minimalGrant());
    const digest = TypedDataEncoder.hash(
      { name: 'Kernel', version: '0.3.3', chainId: CHAIN_ID, verifyingContract: ACCOUNT },
      {
        Enable: [
          { name: 'validationId', type: 'bytes21' },
          { name: 'nonce', type: 'uint32' },
          { name: 'hook', type: 'address' },
          { name: 'validatorData', type: 'bytes' },
          { name: 'hookData', type: 'bytes' },
          { name: 'selectorData', type: 'bytes' },
        ],
      },
      {
        validationId: toHex(inst.validationId),
        nonce: 3,
        hook: '0x0000000000000000000000000000000000000000',
        validatorData: toHex(inst.validatorData),
        hookData: '0x',
        selectorData: '0xe9ae5c53',
      },
    );
    expect(toHex(inst.enable.digest)).toBe(digest);
  });

  it('owner enable signature recovers to the owner over the raw digest', () => {
    const inst = install(minimalGrant());
    const o = owner();
    const sig = signPermissionEnable(o, inst.enable.digest);
    expect(sig.length).toBe(65);
    expect(recoverAddress(toHex(inst.enable.digest), toHex(sig))).toBe(o.address);
  });

  it('session signature recovers to the session key via EIP-191, never the owner', () => {
    const hash = getBytes(keccak256('0x1234'));
    const sig = signWithSessionKey(session(), hash);
    expect(sig[0]).toBe(0xff);
    expect(recoverAddress(hashMessage(hash), toHex(sig.slice(1)))).toBe(SESSION_ADDRESS);
  });

  it('enable envelope = 20-byte hook || abi.encode(bytes x5)', () => {
    const inst = install(minimalGrant());
    const env = encodeEnableModeSignature({
      validatorData: inst.validatorData,
      enableSignature: toBytes(OWNER_ENABLE_SIG_VECTOR),
      userOpSignature: sessionStubSignature(),
    });
    expect(toHex(env.slice(0, 20))).toBe('0x' + '00'.repeat(20));
    const decoded = coder.decode(['bytes', 'bytes', 'bytes', 'bytes', 'bytes'], env.slice(20));
    expect(decoded[0]).toBe(toHex(inst.validatorData));
    expect(decoded[1]).toBe('0x');
    expect(decoded[2]).toBe('0xe9ae5c53');
    expect(decoded[3]).toBe(OWNER_ENABLE_SIG_VECTOR);
    expect(decoded[4]).toBe(toHex(sessionStubSignature()));
  });

  it('nonce key layout: mode | 0x02 | permissionId | 16 zero bytes | parallel key', () => {
    const key = sessionNonceKey('0xdeadbeef', { mode: 'enable', parallelKey: 0x1234 });
    expect('0x' + key.toString(16).padStart(48, '0')).toBe('0x0102deadbeef' + '00'.repeat(16) + '1234');
    expect(() => sessionNonceKey('0xdeadbeef', { parallelKey: 0x10000 })).toThrow(/uint16/);
    expect(() => sessionNonceKey('0xdead')).toThrow(/4 bytes/);
  });

  it('install and revoke calldata decode with ethers', () => {
    const inst = install(fullGrant());
    const [vIds, configs, data, hooks] = kernelAbi.decodeFunctionData('installValidations', inst.installCalls[0]!.data);
    expect(vIds).toEqual([toHex(inst.validationId)]);
    expect(configs.map((c: [bigint, string]) => [c[0], c[1]])).toEqual([[3n, '0x0000000000000000000000000000000000000000']]);
    expect(data).toEqual([toHex(inst.validatorData)]);
    expect(hooks).toEqual(['0x']);
    const [rvId, deinit, hookDeinit] = kernelAbi.decodeFunctionData(
      'uninstallValidation',
      encodePermissionRevoke(inst.permissionId, inst.policyCount),
    );
    expect(rvId).toBe(toHex(inst.validationId));
    expect(hookDeinit).toBe('0x');
    expect((coder.decode(['bytes[]'], deinit)[0] as string[]).length).toBe(inst.policyCount + 1);
    const call = permissionRevokeCall(ACCOUNT, inst.permissionId, inst.policyCount);
    expect(call.to).toBe(ACCOUNT);
    expect(call.value).toBe(0n);
    expect(() => encodePermissionRevoke(inst.permissionId, -1)).toThrow();
  });

  it('nextValidationNonce follows Kernel _enableDigest', () => {
    expect(nextValidationNonce(3, 0)).toBe(3);
    expect(nextValidationNonce(3, 3)).toBe(4);
    expect(nextValidationNonce(5, 2)).toBe(5);
  });
});

describe('grant validation edge cases (local, no network)', () => {
  it('value cap 0 is valid and encodes as zero', () => {
    const grant = minimalGrant();
    validateSessionKeyGrant(grant, { account: ACCOUNT, now: NOW });
    const [perms] = coder.decode([CALL_POLICY_PERMISSION_TYPE], encodeCallPolicyData(grant.calls)) as unknown as [
      Array<[string, string, string, bigint]>,
    ];
    expect(perms[0]![3]).toBe(0n);
  });

  it('refuses an empty call list', () => {
    expect(() => validateSessionKeyGrant({ ...minimalGrant(), calls: [] }, { now: NOW })).toThrow(/at least one call/);
  });

  it('refuses an expired window before any network call', async () => {
    let requests = 0;
    const node: JsonRpcTransport = async () => {
      requests++;
      return '0x';
    };
    const expired = { ...minimalGrant(), validUntil: NOW - 1 };
    await expect(
      prepareKernelPermissionInstall(node, expired, { chainId: CHAIN_ID, account: ACCOUNT, now: NOW }),
    ).rejects.toThrow(/expired/);
    expect(requests).toBe(0);
    expect(() => install(expired)).toThrow(/expired/);
  });

  it('refuses open-ended, inverted and out-of-range windows', () => {
    expect(() => validateSessionKeyGrant({ ...minimalGrant(), validUntil: 0 }, { now: null })).toThrow(/non-zero/);
    expect(() => validateSessionKeyGrant({ ...minimalGrant(), validAfter: 1790000600 }, { now: null })).toThrow(/after/);
    expect(() => validateSessionKeyGrant({ ...minimalGrant(), validUntil: 2 ** 48 }, { now: null })).toThrow(/uint48/);
  });

  it('refuses wildcard (zero-address) targets, duplicates, bad selectors', () => {
    const base = minimalGrant();
    const zero = '0x0000000000000000000000000000000000000000';
    expect(() =>
      validateSessionKeyGrant({ ...base, calls: [{ target: zero, selector: null, valueLimit: 0n }] }, { now: null }),
    ).toThrow(/wildcard/);
    expect(() =>
      validateSessionKeyGrant({ ...base, calls: [base.calls[1]!, { ...base.calls[1]!, valueLimit: 5n }] }, { now: null }),
    ).toThrow(/duplicates/);
    expect(() =>
      validateSessionKeyGrant({ ...base, calls: [{ target: FIXED, selector: '0x1234', valueLimit: 0n }] }, { now: null }),
    ).toThrow(/selector/);
  });

  it('refuses self-calls with calldata or value (privilege escalation guard)', () => {
    const grant = { ...minimalGrant(), calls: [{ target: ACCOUNT, selector: '0x9198bdf5', valueLimit: 0n }] };
    expect(() => validateSessionKeyGrant(grant, { account: ACCOUNT, now: null })).toThrow(/account itself/);
    const valued = { ...minimalGrant(), calls: [{ target: ACCOUNT, selector: null, valueLimit: 1n }] };
    expect(() => validateSessionKeyGrant(valued, { account: ACCOUNT, now: null })).toThrow(/account itself/);
  });

  it('refuses rules without a selector and multi-param non-oneOf rules', () => {
    const word = pad32('0x01');
    expect(() =>
      validateSessionKeyGrant(
        { ...minimalGrant(), calls: [{ target: FIXED, selector: null, valueLimit: 0n, rules: [{ condition: 'equal', offset: 0, params: [word] }] }] },
        { now: null },
      ),
    ).toThrow(/need a selector/);
    expect(() =>
      validateSessionKeyGrant(
        {
          ...minimalGrant(),
          calls: [{ target: TOKEN, selector: '0xa9059cbb', valueLimit: 0n, rules: [{ condition: 'equal', offset: 0, params: [word, word] }] }],
        },
        { now: null },
      ),
    ).toThrow(/oneOf/);
  });

  it('refuses a zero or oversized gas budget and a zero rate-limit count', () => {
    expect(() => validateSessionKeyGrant({ ...minimalGrant(), gasBudgetWei: 0n }, { now: null })).toThrow(/gasBudget/);
    expect(() => validateSessionKeyGrant({ ...minimalGrant(), gasBudgetWei: 1n << 128n }, { now: null })).toThrow(/gasBudget/);
    expect(() =>
      validateSessionKeyGrant({ ...minimalGrant(), rateLimit: { count: 0, intervalSeconds: 60 } }, { now: null }),
    ).toThrow(/count/);
  });

  it('assertCallsAllowed mirrors CallPolicy lookup, value cap and rules', () => {
    const grant = fullGrant();
    const t = 1790000100;
    assertCallsAllowed(grant, [{ to: FIXED, value: 1n, data: new Uint8Array(0) }], t);
    expect(() => assertCallsAllowed(grant, [{ to: FIXED, value: 2n, data: new Uint8Array(0) }], t)).toThrow(/exceeds/);
    expect(() =>
      assertCallsAllowed(grant, [{ to: '0x0000000000000000000000000000000000000001', value: 0n, data: new Uint8Array(0) }], t),
    ).toThrow(/not allowed/);
    const approve = (spender: string, amount: bigint) =>
      toBytes('0x095ea7b3' + coder.encode(['address', 'uint256'], [spender, amount]).slice(2));
    assertCallsAllowed(grant, [{ to: TOKEN, value: 0n, data: approve(SPENDER, 1_000_000n) }], t);
    expect(() => assertCallsAllowed(grant, [{ to: TOKEN, value: 0n, data: approve(SPENDER, 1_000_001n) }], t)).toThrow(
      /rule 1/,
    );
    expect(() => assertCallsAllowed(grant, [{ to: TOKEN, value: 0n, data: approve(FIXED, 1n) }], t)).toThrow(/rule 0/);
    expect(() => assertCallsAllowed(grant, [{ to: FIXED, value: 0n, data: new Uint8Array(0) }], 1790000600)).toThrow(
      /expired/,
    );
    expect(() => assertCallsAllowed(grant, [{ to: FIXED, value: 0n, data: new Uint8Array(0) }], 1789999999)).toThrow(
      /not valid until/,
    );
  });

  it('serialize / parse round-trip preserves the grant exactly', () => {
    const grant = fullGrant();
    const json = JSON.parse(JSON.stringify(serializeSessionKeyGrant(grant)));
    expect(parseSessionKeyGrant(json)).toEqual(grant);
    expect(() => parseSessionKeyGrant({ ...json, version: 2 })).toThrow(/version-1/);
    expect(() => parseSessionKeyGrant({ ...json, gasBudgetWei: '1e18' })).toThrow(/decimal/);
  });
});

describe('ERC-7715 request mapping', () => {
  it('round-trips through the request shape', () => {
    const grant = fullGrant();
    const request = grantToErc7715Request(grant, { chainId: CHAIN_ID, account: ACCOUNT });
    expect(request.chainId).toBe('0xaa36a7');
    expect(request.to).toBe(SESSION_ADDRESS);
    expect(request.permission.type).toBe(ERC7715_CALLS_PERMISSION_TYPE);
    expect(request.rules).toEqual([{ type: 'expiry', data: { timestamp: 1790000600 } }]);
    const back = grantFromErc7715Request(JSON.parse(JSON.stringify(request)), {
      chainId: CHAIN_ID,
      account: ACCOUNT,
      now: NOW,
    });
    expect(back.grant).toEqual(grant);
    expect(back.isAdjustmentAllowed).toBe(false);
  });

  it('refuses native-token-allowance (cumulative allowances are not enforceable here)', () => {
    const request = {
      chainId: '0xaa36a7',
      to: SESSION_ADDRESS,
      permission: { type: 'native-token-allowance', isAdjustmentAllowed: false, data: { allowance: '0x1DCD6500' } },
      rules: [{ type: 'expiry', data: { timestamp: 1790000600 } }],
    };
    try {
      grantFromErc7715Request(request, { chainId: CHAIN_ID, account: ACCOUNT, now: NOW });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(Erc7715RequestError);
      expect((error as Erc7715RequestError).reason).toBe('unsupported');
    }
  });

  it('refuses wrong chain, wrong from, missing expiry, unknown rules, expired windows', () => {
    const ok = grantToErc7715Request(minimalGrant(), { chainId: CHAIN_ID, account: ACCOUNT });
    const opts = { chainId: CHAIN_ID, account: ACCOUNT, now: NOW };
    expect(() => grantFromErc7715Request({ ...ok, chainId: '0x1' }, opts)).toThrow(/active chain/);
    expect(() => grantFromErc7715Request({ ...ok, from: FIXED }, opts)).toThrow(/from/);
    expect(() => grantFromErc7715Request({ ...ok, rules: [] }, opts)).toThrow(/expiry rule is required/);
    expect(() =>
      grantFromErc7715Request({ ...ok, rules: [...ok.rules!, { type: 'spend-limit', data: {} }] }, opts),
    ).toThrow(/not supported/);
    expect(() => grantFromErc7715Request(ok, { ...opts, now: 1790000600 })).toThrow(/expired/);
  });
});

/** ABI-encoded getter answers for a fake Kernel account. */
function fakeKernelNode(state: {
  currentNonce: number;
  vNonce: number;
  hook: string;
  signer: string;
  policies: string[];
  allowed: boolean;
  policyStatus?: number;
}): { node: JsonRpcTransport; calls: string[] } {
  const calls: string[] = [];
  const node: JsonRpcTransport = async (method, params) => {
    calls.push(method);
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const data = (params[0] as { data: string }).data;
    const sel = data.slice(0, 10);
    if (sel === kernelAbi.getFunction('currentNonce')!.selector) return coder.encode(['uint32'], [state.currentNonce]);
    if (sel === kernelAbi.getFunction('validationConfig')!.selector) {
      return coder.encode(['tuple(uint32,address)'], [[state.vNonce, state.hook]]);
    }
    if (sel === kernelAbi.getFunction('permissionConfig')!.selector) {
      return coder.encode(['tuple(bytes2,address,bytes22[])'], [['0x0002', state.signer, state.policies]]);
    }
    if (sel === kernelAbi.getFunction('isAllowedSelector')!.selector) return coder.encode(['bool'], [state.allowed]);
    if (sel === new Interface(['function status(bytes32,address)']).getFunction('status')!.selector) {
      return coder.encode(['uint8'], [state.policyStatus ?? 0]);
    }
    if (sel === new Interface(['function signer(bytes32,address)']).getFunction('signer')!.selector) {
      return coder.encode(['address'], ['0x0000000000000000000000000000000000000000']);
    }
    throw new Error(`unexpected call ${sel}`);
  };
  return { node, calls };
}

describe('on-chain state reads (fake node)', () => {
  it('parses permissionConfig / validationConfig / isAllowedSelector', async () => {
    const policy = '0x0000' + KERNEL_PERMISSION_MODULES.callPolicy.slice(2);
    const { node } = fakeKernelNode({
      currentNonce: 4,
      vNonce: 3,
      hook: '0x0000000000000000000000000000000000000001',
      signer: KERNEL_PERMISSION_MODULES.ecdsaSigner,
      policies: [policy, '0x0000' + KERNEL_PERMISSION_MODULES.timestampPolicy.slice(2)],
      allowed: true,
    });
    const state = await readKernelPermissionState(node, ACCOUNT, '0x5dc4ffae');
    expect(state.currentNonce).toBe(4);
    expect(state.validationNonce).toBe(3);
    expect(state.permissionFlag).toBe(KERNEL_PASS_FLAG_SKIP_SIGNATURE);
    expect(state.signer).toBe(KERNEL_PERMISSION_MODULES.ecdsaSigner);
    expect(state.policies.map((p) => p.policy)).toEqual([
      KERNEL_PERMISSION_MODULES.callPolicy,
      KERNEL_PERMISSION_MODULES.timestampPolicy,
    ]);
    expect(state.installed).toBe(true);
  });

  it('prepareKernelPermissionInstall uses the live nonces and refuses reused ids', async () => {
    const fresh = fakeKernelNode({
      currentNonce: 2,
      vNonce: 0,
      hook: '0x0000000000000000000000000000000000000000',
      signer: '0x0000000000000000000000000000000000000000',
      policies: [],
      allowed: false,
    });
    const inst = await prepareKernelPermissionInstall(fresh.node, minimalGrant(), {
      chainId: CHAIN_ID,
      account: ACCOUNT,
      now: NOW,
    });
    expect(inst.enable.nonce).toBe(2);
    const deprecated = fakeKernelNode({
      currentNonce: 2,
      vNonce: 2,
      hook: '0x0000000000000000000000000000000000000000',
      signer: '0x0000000000000000000000000000000000000000',
      policies: [],
      allowed: true,
      policyStatus: 2,
    });
    await expect(
      prepareKernelPermissionInstall(deprecated.node, minimalGrant(), { chainId: CHAIN_ID, account: ACCOUNT, now: NOW }),
    ).rejects.toThrow(/fresh session key/);
  });
});

describe('kernelSessionSpec through SmartAccountClient (fake transports)', () => {
  function harness(enable: boolean) {
    const grant = minimalGrant();
    const inst = install(grant);
    const o = owner();
    const enableSignature = signPermissionEnable(o, inst.enable.digest);
    const spec = kernelSessionSpec({
      account: ACCOUNT,
      sessionKey: SESSION_ADDRESS,
      permissionId: inst.permissionId,
      grant,
      now: () => NOW,
      ...(enable ? { enable: { validatorData: inst.validatorData, enableSignature } } : {}),
    });
    const nonceKeys: bigint[] = [];
    const node: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_getCode') return '0x6001';
      if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data;
        const key = BigInt('0x' + data.slice(10 + 64, 10 + 128));
        nonceKeys.push(key);
        return '0x' + ((key << 64n) + 5n).toString(16).padStart(64, '0');
      }
      throw new Error(`unexpected node ${method}`);
    };
    const sent: Array<Record<string, string>> = [];
    const estimated: Array<Record<string, string>> = [];
    const bundler: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        estimated.push(params[0] as Record<string, string>);
        return { callGasLimit: '0x10000', verificationGasLimit: '0x80000', preVerificationGas: '0x10000' };
      }
      if (method === 'eth_sendUserOperation') {
        sent.push(params[0] as Record<string, string>);
        return '0x' + '11'.repeat(32);
      }
      throw new Error(`unexpected bundler ${method}`);
    };
    // A plain node: SmartAccountClient takes the nonce key from spec.getNonceKey.
    const client = new SmartAccountClient({
      chainId: CHAIN_ID,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
    });
    return { client, spec, inst, sent, estimated, nonceKeys, enableSignature, o, node, bundler };
  }
  const fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 150_000_000n };

  it('default mode: routes the nonce key and signs with the session key', async () => {
    const h = harness(false);
    const calls = [{ to: FIXED, value: 1n, data: new Uint8Array(0) }];
    await h.client.sendCalls(session(), calls, fees);
    expect(h.nonceKeys).toEqual([sessionNonceKey(h.inst.permissionId)]);
    const op = h.sent[0]!;
    expect(BigInt(op.nonce!)).toBe((sessionNonceKey(h.inst.permissionId) << 64n) + 5n);
    expect(op.callData).toBe(toHex(encodeKernelExecute(calls)));
    expect(h.estimated[0]!.signature).toBe(toHex(sessionStubSignature()));
    const userOpHash = getUserOpHash(
      {
        sender: op.sender!,
        nonce: BigInt(op.nonce!),
        callData: toBytes(op.callData!),
        callGasLimit: BigInt(op.callGasLimit!),
        verificationGasLimit: BigInt(op.verificationGasLimit!),
        preVerificationGas: BigInt(op.preVerificationGas!),
        maxFeePerGas: BigInt(op.maxFeePerGas!),
        maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas!),
        signature: new Uint8Array(0),
      },
      ENTRYPOINT_V07,
      CHAIN_ID,
    );
    const sig = toBytes(op.signature!);
    expect(sig[0]).toBe(0xff);
    expect(recoverAddress(hashMessage(userOpHash), toHex(sig.slice(1)))).toBe(SESSION_ADDRESS);
  });

  it('enable mode: envelope carries the owner enable signature, also in the stub', async () => {
    const h = harness(true);
    await h.client.sendCalls(session(), [{ to: ACCOUNT, value: 0n, data: new Uint8Array(0) }], fees);
    expect(h.nonceKeys).toEqual([sessionNonceKey(h.inst.permissionId, { mode: 'enable' })]);
    for (const signature of [h.estimated[0]!.signature!, h.sent[0]!.signature!]) {
      const parts = coder.decode(['bytes', 'bytes', 'bytes', 'bytes', 'bytes'], toBytes(signature).slice(20));
      expect(parts[0]).toBe(toHex(h.inst.validatorData));
      expect(parts[2]).toBe('0xe9ae5c53');
      expect(parts[3]).toBe(toHex(h.enableSignature));
      expect(recoverAddress(toHex(h.inst.enable.digest), parts[3] as string)).toBe(h.o.address);
    }
  });

  it('refuses to be driven by the owner key and refuses disallowed calls before signing', async () => {
    const h = harness(false);
    await expect(h.client.sendCalls(h.o, [{ to: FIXED, value: 1n, data: new Uint8Array(0) }], fees)).rejects.toThrow(
      /signs only with session key/,
    );
    await expect(
      h.client.sendCalls(session(), [{ to: FIXED, value: 2n, data: new Uint8Array(0) }], fees),
    ).rejects.toThrow(/exceeds/);
    expect(h.sent.length).toBe(0);
    expect(h.estimated.length).toBe(0);
  });

  it('undeployed accounts are refused', async () => {
    const h = harness(false);
    await expect(h.spec.getFactoryArgs(session())).rejects.toThrow(/not deployed/);
  });

  it('getNonceKey is the session nonce key; the routeNode compatibility wrapper still rewrites a key-0 read', async () => {
    const h = harness(false);
    expect(h.spec.getNonceKey()).toBe(sessionNonceKey(h.inst.permissionId));
    // A caller that wraps the spec without forwarding getNonceKey still gets
    // the session nonce through routeNode, as before.
    const { getNonceKey: _dropped, ...withoutHook } = h.spec;
    void _dropped;
    const client = new SmartAccountClient({
      chainId: CHAIN_ID,
      entryPoint: ENTRYPOINT_V07,
      bundler: h.bundler,
      node: h.spec.routeNode(h.node),
      spec: withoutHook,
    });
    expect(await client.getNonce(session())).toBe((sessionNonceKey(h.inst.permissionId) << 64n) + 5n);
    expect(h.nonceKeys).toEqual([sessionNonceKey(h.inst.permissionId)]);
  });

  it('routeNode passes every other request through untouched', async () => {
    const seen: unknown[][] = [];
    const node: JsonRpcTransport = async (method, params) => {
      seen.push([method, params]);
      return '0x01';
    };
    const routed = harness(false).spec.routeNode(node);
    await routed('eth_call', [{ to: TOKEN, data: '0x70a08231' }, 'latest']);
    await routed('eth_chainId', []);
    expect(seen).toEqual([
      ['eth_call', [{ to: TOKEN, data: '0x70a08231' }, 'latest']],
      ['eth_chainId', []],
    ]);
  });

  it('createSessionKeyAccount rejects invalid keys', () => {
    expect(() => createSessionKeyAccount(new Uint8Array(32))).toThrow(/valid/);
    expect(() => createSessionKeyAccount(new Uint8Array(31).fill(1))).toThrow(/32-byte/);
  });
});

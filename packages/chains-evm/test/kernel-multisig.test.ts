import { describe, expect, it } from 'vitest';
import { Interface, TypedDataEncoder, hashMessage, recoverAddress } from 'ethers';
import {
  KERNEL_MULTISIG_VALIDATOR,
  MULTISIG_ERC1271_REFUSAL,
  MULTISIG_MAX_SIGNERS,
  approveMultisigRequest,
  buildMultisigSigningRequest,
  createKernelMultisigSpec,
  encodeKernelMultisigInitialize,
  encodeMultisigValidatorData,
  multisigChangeRootValidatorCall,
  multisigExposure,
  multisigFactoryArgs,
  parseMultisigApproval,
  parseMultisigSigningRequest,
  predictKernelMultisigAddress,
  validateMultisigConfig,
  verifyMultisigApproval,
  type MultisigConfig,
} from '../src/kernel-multisig.js';
import { createSessionKeyAccount } from '../src/kernel-permissions.js';
import { KERNEL_V3_3, kernelValidatorId } from '../src/kernel-account.js';
import { SmartAccountClient } from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash, type UserOperation } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/*
 * The weighted validator a multisig is built on is the SAME contract the
 * guardian recovery uses, so its install-data encoding is byte-pinned
 * against the ZeroDev SDK vectors produced for kernel-recovery.test.ts
 * (@zerodev/weighted-ecdsa-validator 5.4.4 getEnableData, installed in a
 * scratchpad only). Signers are the fixed test keys 0x11…11, 0x22…22,
 * 0x33…33, the same keys that produced SDK_ENABLE_DATA below.
 */
const CHAIN_ID = 11155111n;
const S1 = createSessionKeyAccount(toBytes('0x' + '11'.repeat(32)));
const S2 = createSessionKeyAccount(toBytes('0x' + '22'.repeat(32)));
const S3 = createSessionKeyAccount(toBytes('0x' + '33'.repeat(32)));

/** ZeroDev SDK getEnableData for the set below (weights 1, 1, 2; threshold 3; delay 0). */
const SDK_ENABLE_DATA =
  '0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000005cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb00000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000001563915e194d8cfba1943570603f7606a31155080000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001';

const SET_1_1_2: MultisigConfig = {
  signers: [
    { address: S1.address, weight: 1 },
    { address: S2.address, weight: 1 },
    { address: S3.address, weight: 2 },
  ],
  threshold: 3,
  delaySeconds: 0,
};

const APPROVE_TYPES = { Approve: [{ name: 'callDataAndNonceHash', type: 'bytes32' }] };
const approveDomain = {
  name: 'WeightedECDSAValidator',
  version: '0.0.3',
  chainId: Number(CHAIN_ID),
  verifyingContract: KERNEL_MULTISIG_VALIDATOR,
};

describe('validateMultisigConfig', () => {
  const base: MultisigConfig = { signers: [{ address: S1.address, weight: 1 }, { address: S2.address, weight: 1 }], threshold: 2, delaySeconds: 0 };
  it('accepts a well-formed set', () => {
    expect(() => validateMultisigConfig(base)).not.toThrow();
  });
  const cases: Array<[string, MultisigConfig, RegExp]> = [
    ['no signers', { ...base, signers: [] }, /at least one signer/],
    ['too many signers', { ...base, signers: Array.from({ length: MULTISIG_MAX_SIGNERS + 1 }, (_, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), weight: 1 })) }, /At most/],
    ['duplicate signer (case-insensitive)', { ...base, signers: [base.signers[0]!, { address: S1.address.toLowerCase(), weight: 1 }] }, /duplicates/],
    ['zero address', { ...base, signers: [...base.signers, { address: '0x' + '0'.repeat(40), weight: 1 }] }, /zero address/],
    ['list-end marker', { ...base, signers: [...base.signers, { address: '0x' + 'ff'.repeat(20), weight: 1 }] }, /list-end/],
    ['weight 0', { ...base, signers: [{ ...base.signers[0]!, weight: 0 }, base.signers[1]!] }, /weight must be/],
    ['threshold 0', { ...base, threshold: 0 }, /positive integer/],
    ['threshold above total', { ...base, threshold: 3 }, /exceeds the total/],
    ['delay wraps uint48', { ...base, delaySeconds: 2 ** 32 }, /at most/],
  ];
  for (const [name, cfg, re] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => validateMultisigConfig(cfg)).toThrow(re);
    });
  }
});

describe('install data and address', () => {
  it('encodes the validator install data byte-identically to the ZeroDev SDK', () => {
    expect(toHex(encodeMultisigValidatorData(SET_1_1_2))).toBe(SDK_ENABLE_DATA.toLowerCase());
  });

  it('sorts signers descending regardless of input order', () => {
    const shuffled: MultisigConfig = { ...SET_1_1_2, signers: [SET_1_1_2.signers[2]!, SET_1_1_2.signers[0]!, SET_1_1_2.signers[1]!] };
    expect(toHex(encodeMultisigValidatorData(shuffled))).toBe(SDK_ENABLE_DATA.toLowerCase());
  });

  it('builds initialize() with the weighted validator as the root', () => {
    const iface = new Interface(['function initialize(bytes21,address,bytes,bytes,bytes[])']);
    const decoded = iface.decodeFunctionData('initialize', toHex(encodeKernelMultisigInitialize(SET_1_1_2)));
    expect(decoded[0].toLowerCase()).toBe(toHex(kernelValidatorId(KERNEL_MULTISIG_VALIDATOR)));
    expect(decoded[1]).toBe('0x0000000000000000000000000000000000000000');
    expect(decoded[2].toLowerCase()).toBe(SDK_ENABLE_DATA.toLowerCase());
    expect(decoded[3]).toBe('0x');
    expect(decoded[4]).toEqual([]);
  });

  it('predicts a CREATE2 address sensitive to the set, the threshold and the index', () => {
    const a = predictKernelMultisigAddress(SET_1_1_2);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(predictKernelMultisigAddress(SET_1_1_2)).toBe(a);
    expect(predictKernelMultisigAddress({ ...SET_1_1_2, threshold: 2 })).not.toBe(a);
    expect(predictKernelMultisigAddress(SET_1_1_2, { index: 1n })).not.toBe(a);
  });

  it('builds the meta-factory and direct-factory deploy calls', () => {
    const meta = multisigFactoryArgs(SET_1_1_2);
    expect(meta.factory).toBe(KERNEL_V3_3.metaFactory);
    const metaIface = new Interface(['function deployWithFactory(address,bytes,bytes32)']);
    const md = metaIface.decodeFunctionData('deployWithFactory', toHex(meta.factoryData));
    expect(md[0]).toBe(KERNEL_V3_3.factory);
    expect(md[2]).toBe('0x' + '0'.repeat(64));

    const direct = multisigFactoryArgs(SET_1_1_2, { metaFactory: null });
    expect(direct.factory).toBe(KERNEL_V3_3.factory);
    const directIface = new Interface(['function createAccount(bytes,bytes32)']);
    expect(() => directIface.decodeFunctionData('createAccount', toHex(direct.factoryData))).not.toThrow();
  });

  it('builds a changeRootValidator call targeting the account', () => {
    const account = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
    const call = multisigChangeRootValidatorCall(account, SET_1_1_2);
    expect(call.to).toBe(account);
    const iface = new Interface(['function changeRootValidator(bytes21,address,bytes,bytes)']);
    const d = iface.decodeFunctionData('changeRootValidator', toHex(call.data));
    expect(d[0].toLowerCase()).toBe(toHex(kernelValidatorId(KERNEL_MULTISIG_VALIDATOR)));
    expect(d[2].toLowerCase()).toBe(SDK_ENABLE_DATA.toLowerCase());
  });
});

describe('multisigExposure (operations vs messages)', () => {
  it('a 2-of-2 is one signer short for messages', () => {
    const e = multisigExposure({ signers: [{ address: S1.address, weight: 1 }, { address: S2.address, weight: 1 }], threshold: 2 });
    expect(e.operationMinimumSigners).toBe(2);
    expect(e.messageMinimumSigners).toBe(1);
    expect(e.singleSignerCanSignMessages).toBe(true);
    expect(e.messageWeakerThanOperation).toBe(true);
  });

  it('a 2-of-3 needs 2 for an operation but 1 for a message', () => {
    const e = multisigExposure({ signers: [{ address: S1.address, weight: 1 }, { address: S2.address, weight: 1 }, { address: S3.address, weight: 1 }], threshold: 2 });
    expect(e.operationMinimumSigners).toBe(2);
    expect(e.messageMinimumSigners).toBe(1);
  });

  it('a 3-of-5 needs 3 for an operation but 2 for a message', () => {
    const signers = [1, 2, 3, 4, 5].map((i) => ({ address: '0x' + i.toString(16).padStart(40, '0'), weight: 1 }));
    const e = multisigExposure({ signers, threshold: 3 });
    expect(e.operationMinimumSigners).toBe(3);
    expect(e.messageMinimumSigners).toBe(2);
  });

  it('the impossibility is general: for every equal-weight k-of-n with k>=2, messages need one fewer signer', () => {
    for (let n = 2; n <= 10; n++) {
      for (let k = 2; k <= n; k++) {
        const signers = Array.from({ length: n }, (_, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), weight: 1 }));
        const e = multisigExposure({ signers, threshold: k });
        expect(e.operationMinimumSigners).toBe(k);
        expect(e.messageMinimumSigners).toBe(k - 1);
        expect(e.messageWeakerThanOperation).toBe(true);
      }
    }
  });

  it('a single heavy signer can meet a high threshold for messages (weight >= ceil(threshold/2))', () => {
    const e = multisigExposure({ signers: [{ address: S1.address, weight: 3 }, { address: S2.address, weight: 1 }, { address: S3.address, weight: 1 }], threshold: 5 });
    // operation: 3 + 1 + 1 = 5 needs all 3; message: 3 + 3 (heaviest repeated) = 6 >= 5 needs 1.
    expect(e.operationMinimumSigners).toBe(3);
    expect(e.messageMinimumSigners).toBe(1);
    expect(e.singleSignerCanSignMessages).toBe(true);
  });
});

describe('co-signer request and approval', () => {
  const account = predictKernelMultisigAddress(SET_1_1_2);
  const calls = [{ to: S1.address, value: 0n, data: new Uint8Array(0) }];
  const request = buildMultisigSigningRequest({ chainId: CHAIN_ID, account, calls, nonce: 0n });

  it('round-trips through the strict parser', () => {
    expect(() => parseMultisigSigningRequest(request)).not.toThrow();
    expect(parseMultisigSigningRequest(request).callDataAndNonceHash).toBe(request.callDataAndNonceHash);
  });

  it("re-derives and checks the request's own hashes", () => {
    expect(() => parseMultisigSigningRequest({ ...request, callDataAndNonceHash: '0x' + '0'.repeat(64) })).toThrow(/does not match/);
    expect(() => parseMultisigSigningRequest({ ...request, approvalDigest: '0x' + '0'.repeat(64) })).toThrow(/approvalDigest/);
  });

  it("the approval digest matches an independent ethers EIP-712 hash of the validator's Approve type", () => {
    const expected = TypedDataEncoder.hash(approveDomain, APPROVE_TYPES, { callDataAndNonceHash: request.callDataAndNonceHash });
    expect(request.approvalDigest).toBe(expected);
  });

  it('verifies an approval and recovers the signer (cross-checked with ethers)', () => {
    const approval = approveMultisigRequest(request, S2);
    const { address, weight } = verifyMultisigApproval(request, approval, SET_1_1_2);
    expect(address.toLowerCase()).toBe(S2.address.toLowerCase());
    expect(weight).toBe(1);
    // Independent recovery over the request digest.
    const recovered = recoverAddress(request.approvalDigest, approval.signature);
    expect(recovered.toLowerCase()).toBe(S2.address.toLowerCase());
  });

  it('refuses an approval from a non-signer and a tampered signature', () => {
    const outsider = createSessionKeyAccount(toBytes('0x' + '44'.repeat(32)));
    expect(() => verifyMultisigApproval(request, approveMultisigRequest(request, outsider), SET_1_1_2)).toThrow(/not a signer/);
    const good = approveMultisigRequest(request, S2);
    const tampered = { ...good, signature: good.signature.slice(0, -2) + (good.signature.endsWith('b') ? 'c' : 'b') };
    // Either the recovered address changes (not a signer) or the claimed signer no longer matches.
    expect(() => verifyMultisigApproval(request, tampered, SET_1_1_2)).toThrow();
  });

  it('parses an untrusted approval strictly', () => {
    expect(() => parseMultisigApproval({ signer: S1.address, signature: '0x1234' })).toThrow(/65 bytes/);
    expect(() => parseMultisigApproval({ signer: 'nope', signature: '0x' + '0'.repeat(130) })).toThrow(/not an address/);
  });
});

describe('createKernelMultisigSpec', () => {
  // A 2-of-3 with equal weights: an operation needs two distinct signers.
  const SET: MultisigConfig = {
    signers: [
      { address: S1.address, weight: 1 },
      { address: S2.address, weight: 1 },
      { address: S3.address, weight: 1 },
    ],
    threshold: 2,
    delaySeconds: 0,
  };
  const account = predictKernelMultisigAddress(SET);

  function fakeNode(nonce = 0n): JsonRpcTransport {
    return async (method, params) => {
      if (method === 'eth_call') {
        const tx = params[0] as { to: string };
        if (tx.to.toLowerCase() === ENTRYPOINT_V07.toLowerCase()) {
          // EntryPoint.getNonce(account, key) -> the sequence number.
          return '0x' + nonce.toString(16).padStart(64, '0');
        }
        // KernelFactory.getAddress cross-check returns the predicted address.
        return '0x' + '0'.repeat(24) + account.slice(2).toLowerCase();
      }
      if (method === 'eth_getCode') return '0x'; // undeployed: the client deploys it
      if (method === 'eth_estimateUserOperationGas') return {};
      throw new Error(`unexpected node ${method}`);
    };
  }

  function fakeBundler(onSend: (op: Record<string, string>) => void): JsonRpcTransport {
    return async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        return { callGasLimit: '0x186a0', verificationGasLimit: '0x493e0', preVerificationGas: '0xea60' };
      }
      if (method === 'eth_sendUserOperation') {
        onSend(params[0] as Record<string, string>);
        return '0x' + 'ab'.repeat(32);
      }
      throw new Error(`unexpected bundler ${method}`);
    };
  }

  it('drives SmartAccountClient end to end: S2 approves, S1 submits (fake bundler and node)', async () => {
    const calls = [{ to: S2.address, value: 0n, data: new Uint8Array(0) }];
    // S2 approves the exact calls at nonce 0; S1 is the submitter.
    const request = buildMultisigSigningRequest({ chainId: CHAIN_ID, account, calls, nonce: 0n });
    const approval = approveMultisigRequest(request, S2);
    const spec = createKernelMultisigSpec({ node: fakeNode(), config: SET, submitter: S1.address, approvals: [approval] });
    let sent: Record<string, string> | undefined;
    const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: fakeBundler((op) => (sent = op)), node: fakeNode(), spec });
    const fees = { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const { userOp } = await client.sendCalls(S1, calls, fees);
    // The signature is the co-signer's Approve sig followed by the submitter's userOpHash sig.
    const sig = toHex(userOp.signature);
    expect(sig.length).toBe(2 + 130 + 130);
    const approveSig = approval.signature;
    expect(sig.startsWith(approveSig)).toBe(true);
    // The last 65 bytes recover to S1 over the EIP-191 userOpHash.
    const uoh = getUserOpHash({ ...userOp, signature: new Uint8Array(0) }, ENTRYPOINT_V07, CHAIN_ID);
    const lastSig = '0x' + sig.slice(sig.length - 130);
    const recovered = recoverAddress(hashMessage(uoh), lastSig);
    expect(recovered.toLowerCase()).toBe(S1.address.toLowerCase());
    expect(sent!.sender.toLowerCase()).toBe(account.toLowerCase());
  });

  it('refuses when the combined weight is below the threshold', async () => {
    // No co-signer approvals: S1 alone (weight 1) cannot reach threshold 2.
    const spec = createKernelMultisigSpec({ node: fakeNode(), config: SET, submitter: S1.address, approvals: [] });
    const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: fakeBundler(() => {}), node: fakeNode(), spec });
    await expect(client.sendCalls(S1, [{ to: S2.address, value: 0n, data: new Uint8Array(0) }], { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).rejects.toThrow(/below the threshold/);
  });

  it('refuses when the submitter also appears in the approvals (the validator counts each signer once)', async () => {
    const calls = [{ to: S2.address, value: 0n, data: new Uint8Array(0) }];
    const request = buildMultisigSigningRequest({ chainId: CHAIN_ID, account, calls, nonce: 0n });
    const spec = createKernelMultisigSpec({ node: fakeNode(), config: SET, submitter: S1.address, approvals: [approveMultisigRequest(request, S1)] });
    const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: fakeBundler(() => {}), node: fakeNode(), spec });
    await expect(client.sendCalls(S1, calls, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).rejects.toThrow(/submitter must not also appear/);
  });

  it('refuses a stale approval (collected for a different call)', async () => {
    const otherRequest = buildMultisigSigningRequest({ chainId: CHAIN_ID, account, calls: [{ to: S3.address, value: 5n, data: new Uint8Array(0) }], nonce: 0n });
    const staleApproval = approveMultisigRequest(otherRequest, S2);
    const spec = createKernelMultisigSpec({ node: fakeNode(), config: SET, submitter: S1.address, approvals: [staleApproval] });
    const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler: fakeBundler(() => {}), node: fakeNode(), spec });
    // The approval over the other call does not recover to a signer of THIS operation.
    await expect(client.sendCalls(S1, [{ to: S2.address, value: 0n, data: new Uint8Array(0) }], { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).rejects.toThrow(/stale or wrong approval|below the threshold/);
  });

  it('refuses a submitter that is not a configured signer', () => {
    const outsider = createSessionKeyAccount(toBytes('0x' + '55'.repeat(32)));
    expect(() => createKernelMultisigSpec({ node: fakeNode(), config: SET, submitter: outsider.address, approvals: [] })).toThrow(/not one of the multisig signers/);
  });

  it('does not offer ERC-1271 message signing', () => {
    const spec = createKernelMultisigSpec({ node: fakeNode(), config: SET, submitter: S1.address, approvals: [] });
    expect((spec as { signErc1271?: unknown }).signErc1271).toBeUndefined();
    expect(MULTISIG_ERC1271_REFUSAL).toMatch(/cannot sign messages/);
  });
});

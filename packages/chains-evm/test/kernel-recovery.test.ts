import { describe, expect, it } from 'vitest';
import { Interface, TypedDataEncoder, hashMessage, id as ethersId, recoverAddress } from 'ethers';
import {
  ECDSA_OWNER_REGISTERED_TOPIC,
  KERNEL_RECOVERY_MODULES,
  KERNEL_RECOVERY_SELECTOR,
  WEIGHTED_ECDSA_APPROVE_TYPE_HASH,
  assembleGuardianApprovals,
  buildGuardianRecoveryRequest,
  callDataAndNonceHash,
  createRecoveryMetadata,
  currentOwnerOf,
  GUARDIAN_NONCE_LANES,
  MAX_GUARDIAN_APPROVAL_SCAN_BLOCKS,
  decodeGuardianApprovalCall,
  guardianDelayWraps,
  maxNonWrappingGuardianDelay,
  scanGuardianApprovals,
  encodeApproveWithSig,
  encodeGuardianSetData,
  GUARDIAN_DELAY_TOO_LONG,
  MAX_GUARDIAN_DELAY_SECONDS,
  encodeGuardianSignature,
  encodeGuardianValidatorInstall,
  encodeRecoveryActionInstall,
  encodeRecoveryCallData,
  encodeVetoCall,
  findKernelAccountsByOwner,
  guardianApprovalDigest,
  guardianApprovalTypedData,
  guardianInstallCalls,
  guardianNonceKey,
  guardianRenewCall,
  guardianSignatureExposure,
  guardianStubSignature,
  guardianUninstallCalls,
  kernelGuardianRecoverySpec,
  kernelRecoveredAccountSpec,
  ownerRotationCalls,
  parseGuardianRecoveryRequest,
  parseRecoveryMetadata,
  prepareGuardianInstall,
  prepareGuardianRecovery,
  readGuardianState,
  readKernelOwner,
  readRecoveryProposal,
  recordGuardians,
  recordOwnerChange,
  recoverSignerAddress,
  recoveryCall,
  serializeRecoveryMetadata,
  signGuardianApproval,
  signGuardianUserOpHash,
  validateGuardianSet,
  verifyKernelAccountForOwner,
  verifyRecoveryMetadataOnChain,
  type KernelGuardianSet,
} from '../src/kernel-recovery.js';
import { createSessionKeyAccount } from '../src/kernel-permissions.js';
import { KERNEL_V3_3, encodeKernelExecute, kernelValidatorId, predictKernelAddress } from '../src/kernel-account.js';
import { encodeFunctionCall } from '../src/abi.js';
import { SmartAccountClient } from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash, type UserOperation } from '../src/userop.js';
import { toBytes, toHex, toWord } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/*
 * Reference vectors below were produced 2026-10-01 with ZeroDev's own
 * encoders, installed in a scratchpad only (never in this repository):
 * @zerodev/weighted-ecdsa-validator 5.4.4 (createWeightedECDSAValidator with
 * validatorAddress 0xeD89…EEE — the published 5.4.4 maps that validator to
 * Kernel "0.3.0 || 0.3.1" while the SDK repository at cd7c05b5 maps it to
 * "0.3.0 - 0.3.3"; getEnableData, signUserOperation, getStubSignature,
 * getRecoveryAction, getUpdateConfigCall), @zerodev/weighted-validator 5.5.1
 * (getRecoveryFallbackActionInstallModuleData), @zerodev/sdk 5.5.10
 * (getValidatorPluginInstallModuleData, getPluginInstallCallData,
 * toKernelPluginManager.getNonceKey / signUserOperation, KernelV3_3AccountAbi)
 * and viem 2.57.2 (hashTypedData, getUserOperationHash, encodeFunctionData).
 * Guardian keys are fixed test keys (0x11…11, 0x22…22, 0x33…33).
 */
const CHAIN_ID = 11155111n;
const ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const DEV_OWNER = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const NEW_OWNER = '0x000000000000000000000000000000000000bEEF';
const G1 = createSessionKeyAccount(toBytes('0x' + '11'.repeat(32)));
const G2 = createSessionKeyAccount(toBytes('0x' + '22'.repeat(32)));
const G3 = createSessionKeyAccount(toBytes('0x' + '33'.repeat(32)));

const SDK = {
  enableData:
    '0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000005cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb00000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000001563915e194d8cfba1943570603f7606a31155080000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001',
  recoveryFallbackInstallCall:
    '0x9517e29f0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000e884c2868cc82c16177ec73a93f7d9e6f3a5dc6e000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000b8ac39fd0f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000001FF0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  validatorInstallCall:
    '0x9517e29f0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000ed89244160cfe273800b58b1b534031699dfeeee0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000027400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000180000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000005cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb00000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000001563915e194d8cfba1943570603f7606a3115508000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004ac39fd0f00000000000000000000000000000000000000000000000000000000000000000000000000000000',
  updateConfigCall:
    '0x98c867ca000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000e10000000000000000000000000000000000000000000000000000000000000000200000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000001563915e194d8cfba1943570603f7606a3115508000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001',
  doRecoveryCallData:
    '0xac39fd0f000000000000000000000000845adb2c711129d4f3966735ed98a9f09fc4ce5700000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000bEEF000000000000000000000000',
  nonceKey: 184653631350222635667797788233616845864015993148145664n,
  nonce: 3406258279798667674260205980158845850597380204090400102520761155294593029n,
  callDataAndNonceHash: '0xb10a2eebb7c081d513198c139853c5630489985976ebc8e0cfbeda63ec8d87d0',
  approvalDigest: '0xefa3aa0b04ee077eccd07ad24f1de18555b3cf11c4b0aaae4b4f5c3c84f78945',
  userOpHash: '0xefd9a2fefe52e6c7da01e2265c1aff6d0e1150751b030f13ae73144d565eb992',
  signature:
    '0x5ad2e12fe279d53b464a6cb3708ccf551a3fad589e2494ffb4bd0900869e243430ff4cdd8557a652adca1f81be4ee611dfe4a9828160cab3706d263c2bc4befb1b772650e70dcd8d5309d4abcda6b67b0d9c0bf701c3dc3d8bd5c7ea500f7b194f352fbf9e17130047e89494017dcd892c3d54c15240acfe02c28974a7044912a21cff821ff8dbcfe680aea964dad498b8965192525fd045eccbfca0c927a083eab233a09046dea3d7b7906be9edf1be6f0fd58afcae3beb1ba0dddfc2a86e02da291c',
  stub:
    '0x5ad2e12fe279d53b464a6cb3708ccf551a3fad589e2494ffb4bd0900869e243430ff4cdd8557a652adca1f81be4ee611dfe4a9828160cab3706d263c2bc4befb1b772650e70dcd8d5309d4abcda6b67b0d9c0bf701c3dc3d8bd5c7ea500f7b194f352fbf9e17130047e89494017dcd892c3d54c15240acfe02c28974a7044912a21cfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c',
  uninstallValidation:
    '0xe6f3d50a01eD89244160CfE273800B58b1B534031699dFeEEE00000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  revokeAccess:
    '0xb9b8294101eD89244160CfE273800B58b1B534031699dFeEEE0000000000000000000000ac39fd0f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  uninstallFallback:
    '0xa71763a80000000000000000000000000000000000000000000000000000000000000003000000000000000000000000e884c2868cc82c16177ec73a93f7d9e6f3a5dc6e00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004ac39fd0f00000000000000000000000000000000000000000000000000000000',
  veto: '0xfb6f93f9b10a2eebb7c081d513198c139853c5630489985976ebc8e0cfbeda63ec8d87d0',
  approveWithSig:
    '0x8025aa49b10a2eebb7c081d513198c139853c5630489985976ebc8e0cfbeda63ec8d87d00000000000000000000000001d723b78e1d0d84fd0531e2686285fb1b641410600000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000041ababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab00000000000000000000000000000000000000000000000000000000000000',
};

/** The SDK vector's guardian set (weights 1, 1, 2; threshold 3; no delay). */
const SDK_SET: KernelGuardianSet = {
  guardians: [
    { address: G1.address, weight: 1 },
    { address: G2.address, weight: 1 },
    { address: G3.address, weight: 2 },
  ],
  threshold: 3,
  delaySeconds: 0,
};

const SDK_OP: UserOperation = {
  sender: ACCOUNT,
  nonce: SDK.nonce,
  callData: toBytes(SDK.doRecoveryCallData),
  callGasLimit: 100000n,
  verificationGasLimit: 300000n,
  preVerificationGas: 60000n,
  maxFeePerGas: 3000000000n,
  maxPriorityFeePerGas: 1000000000n,
  signature: new Uint8Array(0),
};

const lower = (h: string) => h.toLowerCase();

describe('constants', () => {
  it('recomputes the Approve type hash, the doRecovery selector and the OwnerRegistered topic', () => {
    expect(WEIGHTED_ECDSA_APPROVE_TYPE_HASH).toBe(ethersId('Approve(bytes32 callDataAndNonceHash)'));
    expect(KERNEL_RECOVERY_SELECTOR).toBe(ethersId('doRecovery(address,bytes)').slice(0, 10));
    expect(KERNEL_RECOVERY_SELECTOR).toBe('0xac39fd0f');
    expect(ECDSA_OWNER_REGISTERED_TOPIC).toBe(ethersId('OwnerRegistered(address,address)'));
  });

  it('pins the module addresses the SDK uses', () => {
    expect(KERNEL_RECOVERY_MODULES.weightedEcdsaValidator).toBe('0xeD89244160CfE273800B58b1B534031699dFeEEE');
    expect(KERNEL_RECOVERY_MODULES.recoveryAction).toBe('0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E');
  });
});

describe('guardian set encoding and install calls (pinned against the ZeroDev SDK)', () => {
  it('encodes the guardian set exactly like getEnableData, whatever the input order', () => {
    expect(toHex(encodeGuardianSetData(SDK_SET))).toBe(SDK.enableData);
    const reversed = { ...SDK_SET, guardians: [...SDK_SET.guardians].reverse() };
    expect(toHex(encodeGuardianSetData(reversed))).toBe(SDK.enableData);
  });

  it('builds the validator installModule call like getValidatorPluginInstallModuleData + getPluginInstallCallData', () => {
    expect(toHex(encodeGuardianValidatorInstall(encodeGuardianSetData(SDK_SET)))).toBe(SDK.validatorInstallCall);
  });

  it('builds the fallback installModule call like getRecoveryFallbackActionInstallModuleData', () => {
    expect(toHex(encodeRecoveryActionInstall())).toBe(lower(SDK.recoveryFallbackInstallCall));
  });

  it('returns both install calls as self-calls, validated against the owner', () => {
    const calls = guardianInstallCalls(ACCOUNT, SDK_SET, { owner: DEV_OWNER });
    expect(calls.map((c) => c.to)).toEqual([ACCOUNT, ACCOUNT]);
    expect(calls.map((c) => c.value)).toEqual([0n, 0n]);
    expect(toHex(calls[0]!.data)).toBe(SDK.validatorInstallCall);
    expect(toHex(calls[1]!.data)).toBe(lower(SDK.recoveryFallbackInstallCall));
    expect(() =>
      guardianInstallCalls(ACCOUNT, { ...SDK_SET, guardians: [...SDK_SET.guardians, { address: DEV_OWNER, weight: 1 }] }, { owner: DEV_OWNER }),
    ).toThrow(/current owner/);
  });

  it('builds renew() like getUpdateConfigCall', () => {
    const call = guardianRenewCall(
      { guardians: [{ address: G1.address, weight: 1 }, { address: G2.address, weight: 1 }], threshold: 2, delaySeconds: 3600 },
      { account: ACCOUNT, owner: DEV_OWNER },
    );
    expect(call.to).toBe(KERNEL_RECOVERY_MODULES.weightedEcdsaValidator);
    expect(toHex(call.data)).toBe(SDK.updateConfigCall);
    expect(() =>
      guardianRenewCall({ guardians: [{ address: G1.address, weight: 1 }], threshold: 2, delaySeconds: 0 }, { account: ACCOUNT, owner: DEV_OWNER }),
    ).toThrow(/exceeds the total guardian weight/);
  });

  it('encodes removal as uninstallValidation + grantAccess(false) + uninstallModule(3) (viem with the SDK ABI)', () => {
    const calls = guardianUninstallCalls(ACCOUNT);
    expect(calls.every((c) => c.to === ACCOUNT && c.value === 0n)).toBe(true);
    expect(calls.map((c) => toHex(c.data))).toEqual([lower(SDK.uninstallValidation), lower(SDK.revokeAccess), SDK.uninstallFallback]);
  });
});

describe('guardian-signed recovery operation', () => {
  it('encodes doRecovery(ECDSA validator, bytes20 newOwner) like the SDK test and docs', () => {
    expect(toHex(encodeRecoveryCallData(NEW_OWNER, { account: ACCOUNT }))).toBe(lower(SDK.doRecoveryCallData));
  });

  it('computes the guardian nonce key like the SDK plugin manager', () => {
    expect(guardianNonceKey()).toBe(SDK.nonceKey);
    // mode 0x00 || type 0x01 || validator || parallel key 0x0000
    expect('0x' + guardianNonceKey().toString(16).padStart(48, '0')).toBe(
      lower('0x0001' + KERNEL_RECOVERY_MODULES.weightedEcdsaValidator.slice(2) + '0000'),
    );
  });

  it('computes the proposal hash and the approval digest like viem, and ethers agrees', () => {
    const hash = callDataAndNonceHash(ACCOUNT, toBytes(SDK.doRecoveryCallData), SDK.nonce);
    expect(toHex(hash)).toBe(SDK.callDataAndNonceHash);
    const digest = guardianApprovalDigest(CHAIN_ID, hash);
    expect(toHex(digest)).toBe(SDK.approvalDigest);
    const t = guardianApprovalTypedData(CHAIN_ID, hash);
    expect(TypedDataEncoder.hash(t.domain, t.types, t.message)).toBe(SDK.approvalDigest);
  });

  it('produces the SDK signature byte for byte: approvals (descending) then the submitter over the userOpHash', () => {
    expect(toHex(getUserOpHash(SDK_OP, ENTRYPOINT_V07, CHAIN_ID))).toBe(SDK.userOpHash);
    const digest = toBytes(SDK.approvalDigest);
    // SDK order: signers sorted descending (G3 > G1 > G2); the last (G2) submits.
    const approvals = [signGuardianApproval(G3, digest), signGuardianApproval(G1, digest)];
    const final = signGuardianUserOpHash(G2, toBytes(SDK.userOpHash));
    expect(toHex(encodeGuardianSignature(approvals, final))).toBe(SDK.signature);
    expect(toHex(guardianStubSignature(approvals))).toBe(SDK.stub);
  });

  it('guardian signatures recover with ethers (raw EIP-712 approvals, EIP-191 final)', () => {
    const digest = toBytes(SDK.approvalDigest);
    for (const g of [G1, G2, G3]) {
      const sig = signGuardianApproval(g, digest);
      expect(recoverAddress(SDK.approvalDigest, toHex(sig))).toBe(g.address);
      expect(recoverSignerAddress(digest, sig)).toBe(g.address);
    }
    const final = signGuardianUserOpHash(G2, toBytes(SDK.userOpHash));
    expect(recoverAddress(hashMessage(toBytes(SDK.userOpHash)), toHex(final))).toBe(G2.address);
  });

  it('refuses a zero, self or guardian new owner', () => {
    expect(() => encodeRecoveryCallData('0x0000000000000000000000000000000000000000', { account: ACCOUNT })).toThrow(/zero address/);
    expect(() => encodeRecoveryCallData(ACCOUNT, { account: ACCOUNT })).toThrow(/account itself/);
    expect(() => encodeRecoveryCallData(G1.address, { account: ACCOUNT, guardians: SDK_SET.guardians })).toThrow(/guardians/);
    expect(() => ownerRotationCalls('0x0000000000000000000000000000000000000000', { account: ACCOUNT })).toThrow(/zero address/);
  });

  it('owner rotation calls ECDSAValidator.onUninstall then onInstall(bytes20)', () => {
    const iface = new Interface(['function onUninstall(bytes)', 'function onInstall(bytes)']);
    const calls = ownerRotationCalls(NEW_OWNER, { account: ACCOUNT });
    expect(calls.map((c) => c.to)).toEqual([KERNEL_V3_3.ecdsaValidator, KERNEL_V3_3.ecdsaValidator]);
    expect(toHex(calls[0]!.data)).toBe(iface.encodeFunctionData('onUninstall', ['0x']));
    expect(toHex(calls[1]!.data)).toBe(iface.encodeFunctionData('onInstall', [NEW_OWNER.toLowerCase()]));
  });

  it('encodes veto and approveWithSig like viem', () => {
    const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: NEW_OWNER, nonce: SDK.nonce });
    expect(toHex(encodeVetoCall(SDK.callDataAndNonceHash).data)).toBe(SDK.veto);
    const call = encodeApproveWithSig(request, [toBytes('0x' + 'ab'.repeat(65))]);
    expect(call.to).toBe(KERNEL_RECOVERY_MODULES.weightedEcdsaValidator);
    expect(toHex(call.data)).toBe(SDK.approveWithSig);
  });
});

describe('recovery request and approval assembly', () => {
  const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: NEW_OWNER, nonce: SDK.nonce });

  it('builds a self-consistent, JSON-safe request', () => {
    expect(request.callData).toBe(lower(SDK.doRecoveryCallData));
    expect(request.callDataAndNonceHash).toBe(SDK.callDataAndNonceHash);
    expect(request.approvalDigest).toBe(SDK.approvalDigest);
    expect(parseGuardianRecoveryRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it('refuses a tampered request and a nonce on another lane', () => {
    expect(() => parseGuardianRecoveryRequest({ ...request, newOwner: G1.address })).toThrow(/does not match/);
    expect(() => parseGuardianRecoveryRequest({ ...request, approvalDigest: '0x' + '00'.repeat(32) })).toThrow(/does not match/);
    expect(() => buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: NEW_OWNER, nonce: 5n })).toThrow(/nonce/);
  });

  it('orders approvals descending, drops the submitter, refuses outsiders, duplicates and short weight', () => {
    const digest = toBytes(request.approvalDigest);
    const a1 = signGuardianApproval(G1, digest);
    const a2 = signGuardianApproval(G2, digest);
    const a3 = signGuardianApproval(G3, digest);
    const assembled = assembleGuardianApprovals(request, SDK_SET, [a1, a2, a3], G2.address);
    expect(assembled.approvals.map(toHex)).toEqual([toHex(a3), toHex(a1)]);
    expect(assembled.weight).toBe(4);
    expect(() => assembleGuardianApprovals(request, SDK_SET, [a1], G2.address)).toThrow(/below the threshold/);
    expect(() => assembleGuardianApprovals(request, SDK_SET, [a1, a1], G2.address)).toThrow(/Two approvals/);
    const outsider = createSessionKeyAccount(toBytes('0x' + '44'.repeat(32)));
    expect(() => assembleGuardianApprovals(request, SDK_SET, [signGuardianApproval(outsider, digest)], G2.address)).toThrow(/not a guardian/);
    expect(() => assembleGuardianApprovals(request, SDK_SET, [a3], outsider.address)).toThrow(/Submitter/);
    expect(() => assembleGuardianApprovals(request, { ...SDK_SET, delaySeconds: 60 }, [a3], G2.address)).toThrow(/delay/);
  });

  it('drives SmartAccountClient end to end with the recovery spec (fake bundler and node)', async () => {
    const digest = toBytes(request.approvalDigest);
    const { approvals } = assembleGuardianApprovals(request, SDK_SET, [signGuardianApproval(G3, digest), signGuardianApproval(G1, digest)], G2.address);
    const spec = kernelGuardianRecoverySpec({ request, approvals, submitter: G2.address });
    let sent: Record<string, string> | undefined;
    let nonceAnswer = SDK.nonce;
    const node: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_call') {
        const tx = params[0] as { to: string; data: string };
        expect(tx.to).toBe(ENTRYPOINT_V07);
        // The routed read must ask for the guardian key, never key 0.
        expect(tx.data.toLowerCase()).toBe(
          toHex(encodeFunctionCall('getNonce(address,uint192)', [{ kind: 'address', value: ACCOUNT }, { kind: 'uint256', value: SDK.nonceKey }])),
        );
        return '0x' + nonceAnswer.toString(16).padStart(64, '0');
      }
      if (method === 'eth_getCode') return '0x60';
      throw new Error(`unexpected node call ${method}`);
    };
    const bundler: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        const op = params[0] as Record<string, string>;
        expect(op.signature).toBe(toHex(guardianStubSignature(approvals)));
        return { callGasLimit: '0x186a0', verificationGasLimit: '0x493e0', preVerificationGas: '0xea60' };
      }
      if (method === 'eth_sendUserOperation') {
        sent = params[0] as Record<string, string>;
        return SDK.userOpHash;
      }
      throw new Error(`unexpected bundler call ${method}`);
    };
    const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node: spec.routeNode(node), spec });
    const fees = { maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n };
    await client.sendCalls(G2, [recoveryCall(request)], fees);
    expect(sent!.callData).toBe(lower(SDK.doRecoveryCallData));
    expect(BigInt(sent!.nonce)).toBe(SDK.nonce);
    // Same gas fields as the SDK vector, so the whole signature must equal it.
    expect(sent!.signature).toBe(SDK.signature);

    await expect(client.sendCalls(G1, [recoveryCall(request)], fees)).rejects.toThrow(/submitted by guardian/);
    await expect(client.sendCalls(G2, [{ to: ACCOUNT, value: 0n, data: new Uint8Array(0) }], fees)).rejects.toThrow(/exactly the approved/);
    nonceAnswer = SDK.nonce + 1n;
    await expect(client.sendCalls(G2, [recoveryCall(request)], fees)).rejects.toThrow(/approvals are void/);
  });

  it('exposes the guardian lane through getNonceKey', () => {
    const spec = kernelGuardianRecoverySpec({ request, approvals: [], submitter: G2.address });
    expect(spec.getNonceKey()).toBe(SDK.nonceKey);
    expect(spec.getNonceKey()).toBe(BigInt(request.nonce) >> 64n);
    expect(spec.getNonceKey()).toBe(guardianNonceKey(KERNEL_RECOVERY_MODULES, 0));
  });

  it('works through the getNonceKey hook alone and refuses a moved nonce at signing', async () => {
    const digest = toBytes(request.approvalDigest);
    const { approvals } = assembleGuardianApprovals(request, SDK_SET, [signGuardianApproval(G3, digest), signGuardianApproval(G1, digest)], G2.address);
    const spec = kernelGuardianRecoverySpec({ request, approvals, submitter: G2.address });
    let nonceAnswer = SDK.nonce;
    let sends = 0;
    // A plain node, NOT wrapped in routeNode: the client must ask for the
    // guardian key itself (getNonceKey).
    const node: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_call') {
        const tx = params[0] as { to: string; data: string };
        expect(tx.data.toLowerCase()).toBe(
          toHex(encodeFunctionCall('getNonce(address,uint192)', [{ kind: 'address', value: ACCOUNT }, { kind: 'uint256', value: SDK.nonceKey }])),
        );
        return '0x' + nonceAnswer.toString(16).padStart(64, '0');
      }
      if (method === 'eth_getCode') return '0x60';
      throw new Error(`unexpected node call ${method}`);
    };
    const bundler: JsonRpcTransport = async (method) => {
      if (method === 'eth_estimateUserOperationGas') {
        return { callGasLimit: '0x186a0', verificationGasLimit: '0x493e0', preVerificationGas: '0xea60' };
      }
      if (method === 'eth_sendUserOperation') {
        sends += 1;
        return SDK.userOpHash;
      }
      throw new Error(`unexpected bundler call ${method}`);
    };
    const client = new SmartAccountClient({ chainId: CHAIN_ID, entryPoint: ENTRYPOINT_V07, bundler, node, spec });
    const fees = { maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n };
    const { userOp } = await client.sendCalls(G2, [recoveryCall(request)], fees);
    expect(userOp.nonce).toBe(SDK.nonce);
    expect(toHex(userOp.signature)).toBe(SDK.signature);
    expect(sends).toBe(1);
    // The guardian lane advanced (same key, next sequence): signing refuses.
    nonceAnswer = SDK.nonce + 1n;
    await expect(client.sendCalls(G2, [recoveryCall(request)], fees)).rejects.toThrow(/nonce is .*not the approved .*approvals are void/);
    expect(sends).toBe(1);
  });

  it('signUserOpHash refuses a wrong nonce, a bare hash and a mismatched context', () => {
    const spec = kernelGuardianRecoverySpec({ request, approvals: [], submitter: G2.address });
    const op: UserOperation = {
      sender: ACCOUNT,
      nonce: SDK.nonce,
      callData: toBytes(request.callData),
      callGasLimit: 100_000n,
      verificationGasLimit: 300_000n,
      preVerificationGas: 60_000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      signature: new Uint8Array(0),
    };
    const ctx = (o: UserOperation) => ({ userOp: o, entryPoint: ENTRYPOINT_V07, chainId: CHAIN_ID });
    const hashOf = (o: UserOperation) => getUserOpHash(o, ENTRYPOINT_V07, CHAIN_ID);
    // The approved nonce signs.
    expect(spec.signUserOpHash(G2, hashOf(op), ctx(op))).toBeInstanceOf(Uint8Array);
    // Any other nonce is refused, on the guardian lane or off it.
    const later = { ...op, nonce: SDK.nonce + 1n };
    expect(() => spec.signUserOpHash(G2, hashOf(later), ctx(later))).toThrow(/approvals are void/);
    const keyZero = { ...op, nonce: SDK.nonce & ((1n << 64n) - 1n) };
    expect(() => spec.signUserOpHash(G2, hashOf(keyZero), ctx(keyZero))).toThrow(/approvals are void/);
    // No context: the nonce cannot be checked, so nothing is signed.
    expect(() => spec.signUserOpHash(G2, hashOf(op))).toThrow(/signed only with its operation/);
    // A hash that is not the context operation's hash.
    expect(() => spec.signUserOpHash(G2, hashOf(later), ctx(op))).toThrow(/not the hash of the given operation/);
    // Another sender, chain or EntryPoint.
    expect(() => spec.signUserOpHash(G2, hashOf(op), { ...ctx(op), userOp: { ...op, sender: G1.address } })).toThrow(/refusing sender/);
    expect(() => spec.signUserOpHash(G2, hashOf(op), { ...ctx(op), chainId: 1n })).toThrow(/refusing chain/);
    expect(() => spec.signUserOpHash(G2, hashOf(op), { ...ctx(op), entryPoint: G1.address })).toThrow(/refusing/);
    // The submitter rule still comes first.
    expect(() => spec.signUserOpHash(G1, hashOf(op), ctx(op))).toThrow(/submitted by guardian/);
  });
});

describe('guardian set validation', () => {
  const base: KernelGuardianSet = { guardians: [{ address: G1.address, weight: 1 }, { address: G2.address, weight: 1 }], threshold: 2, delaySeconds: 0 };
  const ctx = { account: ACCOUNT, owner: DEV_OWNER };

  it('accepts a sound set', () => {
    expect(() => validateGuardianSet(base, ctx)).not.toThrow();
  });

  it.each([
    ['threshold 0', { ...base, threshold: 0 }, /positive integer/],
    ['threshold above the total weight', { ...base, threshold: 3 }, /exceeds the total guardian weight/],
    ['no guardians', { ...base, guardians: [] }, /at least one guardian/],
    ['duplicate guardian (case-insensitive)', { ...base, guardians: [base.guardians[0]!, { address: G1.address.toLowerCase(), weight: 1 }] }, /duplicates/],
    ['the account as guardian', { ...base, guardians: [...base.guardians, { address: ACCOUNT, weight: 1 }] }, /account itself/],
    ['the current owner as guardian', { ...base, guardians: [...base.guardians, { address: DEV_OWNER, weight: 1 }] }, /current owner/],
    ['the zero address', { ...base, guardians: [...base.guardians, { address: '0x0000000000000000000000000000000000000000', weight: 1 }] }, /zero address/],
    ['the list end marker', { ...base, guardians: [...base.guardians, { address: '0xffffffffffffffffffffffffffffffffffffffff', weight: 1 }] }, /end marker/],
    ['weight 0', { ...base, guardians: [{ address: G1.address, weight: 0 }, base.guardians[1]!] }, /weight must be/],
    ['weight above uint24', { ...base, guardians: [{ address: G1.address, weight: 0x1000000 }, base.guardians[1]!] }, /weight must be/],
    ['total weight above uint24', { ...base, guardians: [{ address: G1.address, weight: 0xffffff }, base.guardians[1]!] }, /uint24 limit/],
    ['negative delay', { ...base, delaySeconds: -1 }, /delaySeconds/],
    ['delay above uint48', { ...base, delaySeconds: 2 ** 48 }, /delaySeconds/],
    ['a malformed address', { ...base, guardians: [{ address: '0x1234', weight: 1 }] }, /20-byte hex address/],
  ])('refuses %s', (_label, set, error) => {
    expect(() => validateGuardianSet(set as KernelGuardianSet, ctx)).toThrow(error);
  });

  it('refuses more than 32 guardians', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), weight: 1 }));
    expect(() => validateGuardianSet({ guardians: many, threshold: 1, delaySeconds: 0 })).toThrow(/At most 32/);
  });
});

describe('ERC-1271 exposure under the deployed evaluation order', () => {
  it.each([
    ['2 of 2, equal weights', [1, 1], 2, 2, 1],
    ['3 of 3, equal weights', [1, 1, 1], 3, 3, 2],
    ['3 of 5, equal weights', [1, 1, 1, 1, 1], 3, 3, 2],
    ['single guardian', [1], 1, 1, 1],
    ['heavy guardian (2,1,1; threshold 3)', [2, 1, 1], 3, 2, 1],
    ['threshold far above one weight (1,1,1,1; threshold 4)', [1, 1, 1, 1], 4, 4, 3],
  ])('%s', (_label, weights, threshold, recoveryMin, signatureMin) => {
    const set: KernelGuardianSet = {
      guardians: (weights as number[]).map((w, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), weight: w })),
      threshold: threshold as number,
      delaySeconds: 0,
    };
    const e = guardianSignatureExposure(set);
    expect(e.recoveryMinimumGuardians).toBe(recoveryMin);
    expect(e.signatureMinimumGuardians).toBe(signatureMin);
    expect(e.singleGuardianCanSign).toBe(signatureMin === 1);
    expect(e.weakerThanThreshold).toBe((signatureMin as number) < (recoveryMin as number));
  });
});

// ---------------------------------------------------------------------------
// On-chain reads against a fake Kernel + validators
// ---------------------------------------------------------------------------

const word = (v: bigint) => toHex(toWord(v)).slice(2);
const addrWord = (a: string) => toHex(toWord(toBytes(a))).slice(2);

interface FakeChain {
  owner: string;
  code: string;
  rootValidator: string;
  implementation: string;
  guardians: Array<{ address: string; weight: number }> | null;
  threshold: number;
  delay: number;
  installed: boolean;
  logs: Array<{ topics: string[] }>;
}

function fakeChain(overrides: Partial<FakeChain> = {}): { chain: FakeChain; node: JsonRpcTransport } {
  const chain: FakeChain = {
    owner: DEV_OWNER,
    code: '0x363d3d373d3d363d7f360894',
    rootValidator: toHex(kernelValidatorId(KERNEL_V3_3.ecdsaValidator)),
    implementation: KERNEL_V3_3.implementation,
    guardians: null,
    threshold: 0,
    delay: 0,
    installed: false,
    logs: [],
    ...overrides,
  };
  const sel = (sig: string) => toHex(encodeFunctionCall(sig, [])).slice(0, 10);
  const node: JsonRpcTransport = async (method, params) => {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getCode') return chain.code;
    if (method === 'eth_getStorageAt') return '0x' + addrWord(chain.implementation);
    if (method === 'eth_getLogs') return chain.logs;
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const { to, data } = params[0] as { to: string; data: string };
    const s = data.slice(0, 10).toLowerCase();
    const arg = (i: number) => '0x' + data.slice(10 + 24 + i * 64, 10 + (i + 1) * 64);
    if (to.toLowerCase() === ACCOUNT.toLowerCase()) {
      if (s === sel('rootValidator()')) return chain.rootValidator.padEnd(66, '0');
      if (s === sel('validationConfig(bytes21)')) return '0x' + word(1n) + addrWord(chain.installed ? '0x0000000000000000000000000000000000000001' : '0x0000000000000000000000000000000000000000');
      if (s === sel('isAllowedSelector(bytes21,bytes4)')) return '0x' + word(chain.installed ? 1n : 0n);
      if (s === sel('selectorConfig(bytes4)')) {
        return chain.installed
          ? '0x' + addrWord('0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF') + addrWord(KERNEL_RECOVERY_MODULES.recoveryAction) + 'ff'.padEnd(64, '0')
          : '0x' + word(0n) + word(0n) + word(0n);
      }
    }
    if (to.toLowerCase() === KERNEL_V3_3.ecdsaValidator.toLowerCase() && s === sel('ecdsaValidatorStorage(address)')) {
      return '0x' + addrWord(arg(0).toLowerCase() === ACCOUNT.toLowerCase() ? chain.owner : '0x0000000000000000000000000000000000000000');
    }
    if (to.toLowerCase() === KERNEL_RECOVERY_MODULES.weightedEcdsaValidator.toLowerCase()) {
      // Ascending linked list from firstGuardian to the 0xff…ff end marker, as onInstall builds it.
      const list = [...(chain.guardians ?? [])].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
      if (s === sel('weightedStorage(address)')) {
        if (!chain.guardians) return '0x' + word(0n).repeat(4);
        const total = list.reduce((x, g) => x + g.weight, 0);
        return '0x' + word(BigInt(total)) + word(BigInt(chain.threshold)) + word(BigInt(chain.delay)) + addrWord(list[0]!.address);
      }
      if (s === sel('guardian(address,address)')) {
        const i = list.findIndex((g) => g.address.toLowerCase() === arg(0).toLowerCase());
        const next = i + 1 < list.length ? list[i + 1]!.address : '0xffffffffffffffffffffffffffffffffffffffff';
        return '0x' + word(BigInt(list[i]!.weight)) + addrWord(next);
      }
      if (s === sel('proposalStatus(bytes32,address)')) return '0x' + word(1n) + word(1700003600n);
      if (s === sel('getApproval(address,bytes32)')) return '0x' + word(2n) + word(1n);
    }
    if (to.toLowerCase() === ENTRYPOINT_V07.toLowerCase()) {
      return '0x' + word((BigInt('0x' + data.slice(10 + 64, 10 + 128)) << 64n) | 7n);
    }
    throw new Error(`unexpected eth_call to ${to} ${s}`);
  };
  return { chain, node };
}

describe('on-chain reads and prepare helpers (fake node)', () => {
  const set: KernelGuardianSet = { guardians: [{ address: G1.address, weight: 1 }, { address: G2.address, weight: 1 }], threshold: 2, delaySeconds: 0 };

  it('reads the owner and the guardian state', async () => {
    const { node } = fakeChain({ guardians: set.guardians, threshold: 2, installed: true });
    const owner = await readKernelOwner(node, ACCOUNT);
    expect(owner).toEqual({ rootValidator: lower(toHex(kernelValidatorId(KERNEL_V3_3.ecdsaValidator))), ecdsaRoot: true, owner: DEV_OWNER });
    const state = await readGuardianState(node, ACCOUNT);
    expect(state.active).toBe(true);
    expect(state.set).toEqual({ guardians: [{ address: G1.address, weight: 1 }, { address: G2.address, weight: 1 }], threshold: 2, delaySeconds: 0 });
  });

  it('prepares an install only for a deployed proxy Kernel without guardians', async () => {
    const fresh = fakeChain();
    const { calls, owner } = await prepareGuardianInstall(fresh.node, { account: ACCOUNT, set });
    expect(owner).toBe(DEV_OWNER);
    expect(calls).toHaveLength(2);
    await expect(prepareGuardianInstall(fakeChain({ code: '0x' }).node, { account: ACCOUNT, set })).rejects.toThrow(/not deployed/);
    await expect(prepareGuardianInstall(fakeChain({ code: '0xef0100' + KERNEL_V3_3.implementation.slice(2) }).node, { account: ACCOUNT, set })).rejects.toThrow(/EIP-7702/);
    await expect(prepareGuardianInstall(fakeChain({ guardians: set.guardians, threshold: 2, installed: true }).node, { account: ACCOUNT, set })).rejects.toThrow(/already configured/);
    await expect(prepareGuardianInstall(fresh.node, { account: ACCOUNT, set: { ...set, guardians: [...set.guardians, { address: DEV_OWNER, weight: 1 }] } })).rejects.toThrow(/current owner/);
  });

  it('prepares a recovery request from chain state and refuses bad new owners', async () => {
    const { node } = fakeChain({ guardians: set.guardians, threshold: 2, installed: true });
    const { request, set: read, currentOwner } = await prepareGuardianRecovery(node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: NEW_OWNER });
    expect(currentOwner).toBe(DEV_OWNER);
    expect(read.threshold).toBe(2);
    expect(BigInt(request.nonce)).toBe((SDK.nonceKey << 64n) | 7n);
    await expect(prepareGuardianRecovery(node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: DEV_OWNER })).rejects.toThrow(/already the owner/);
    await expect(prepareGuardianRecovery(node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: G1.address })).rejects.toThrow(/guardians/);
    await expect(prepareGuardianRecovery(node, { chainId: 1n, account: ACCOUNT, newOwner: NEW_OWNER })).rejects.toThrow(/chain id/);
    await expect(prepareGuardianRecovery(fakeChain().node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: NEW_OWNER })).rejects.toThrow(/no active guardian/);
  });

  it('reads a proposal', async () => {
    const { node } = fakeChain();
    expect(await readRecoveryProposal(node, ACCOUNT, SDK.callDataAndNonceHash)).toEqual({
      status: 'approved',
      validAfter: 1700003600,
      approvedWeight: 2,
      passed: true,
    });
  });

  it('uses a recovered account only with its on-chain owner', async () => {
    const { node, chain } = fakeChain({ owner: NEW_OWNER });
    const spec = kernelRecoveredAccountSpec({ node, account: ACCOUNT });
    const newOwner = { ...G1, address: NEW_OWNER };
    expect(await spec.getAddress(newOwner)).toBe(ACCOUNT);
    await expect(spec.getAddress(G2)).rejects.toThrow(/is owned by/);
    await expect(spec.getFactoryArgs(newOwner)).rejects.toThrow(/deployed/);
    expect(toHex(spec.encodeCalls([{ to: NEW_OWNER, value: 1n, data: new Uint8Array(0) }]))).toBe(
      toHex(encodeKernelExecute([{ to: NEW_OWNER, value: 1n, data: new Uint8Array(0) }])),
    );
    chain.owner = DEV_OWNER;
  });

  it('verifies accounts for an owner and drops forged OwnerRegistered events', async () => {
    const ownerTopic = (a: string) => '0x' + addrWord(a);
    const forged = '0x000000000000000000000000000000000000dEaD';
    const { node } = fakeChain({
      logs: [
        { topics: [ECDSA_OWNER_REGISTERED_TOPIC, ownerTopic(ACCOUNT), ownerTopic(DEV_OWNER)] },
        { topics: [ECDSA_OWNER_REGISTERED_TOPIC, ownerTopic(forged), ownerTopic(DEV_OWNER)] },
      ],
    });
    const found = await findKernelAccountsByOwner(node, DEV_OWNER, { fromBlock: 1n, toBlock: 2n });
    expect(found.verified).toEqual([ACCOUNT]);
    expect(found.rejected.map((r) => r.account)).toEqual([forged]);
    expect((await verifyKernelAccountForOwner(node, ACCOUNT, NEW_OWNER)).problems[0]).toMatch(/owner is/);
    const delegated = fakeChain({ code: '0xef0100' + KERNEL_V3_3.implementation.slice(2) });
    expect((await verifyKernelAccountForOwner(delegated.node, ACCOUNT, DEV_OWNER)).ok).toBe(false);
    const wrongImpl = fakeChain({ implementation: '0x0000000000000000000000000000000000000001' });
    expect((await verifyKernelAccountForOwner(wrongImpl.node, ACCOUNT, DEV_OWNER)).problems[0]).toMatch(/implementation/);
  });
});

describe('recovery metadata', () => {
  const created = createRecoveryMetadata({
    chainId: CHAIN_ID,
    account: ACCOUNT,
    index: 2n,
    originalOwner: DEV_OWNER,
    originalOwnerPath: "m/44'/60'/0'/0/0",
    recordedAt: 1790000000,
  });

  it('checks the CREATE2 lineage of the account at creation', () => {
    expect(predictKernelAddress(DEV_OWNER, { index: 2n })).toBe(ACCOUNT);
    expect(created.account).toBe(ACCOUNT);
    expect(currentOwnerOf(created)).toBe(DEV_OWNER);
    expect(() => createRecoveryMetadata({ chainId: CHAIN_ID, account: ACCOUNT, index: 1n, originalOwner: DEV_OWNER, recordedAt: 0 })).toThrow(
      /is not the Kernel v3.3 address/,
    );
  });

  it('round-trips through JSON with owner history and guardians', () => {
    let meta = recordGuardians(created, {
      weightedEcdsaValidator: KERNEL_RECOVERY_MODULES.weightedEcdsaValidator,
      recoveryAction: KERNEL_RECOVERY_MODULES.recoveryAction,
      guardians: [{ address: G1.address, weight: 1, label: 'Laptop key' }, { address: G2.address, weight: 1 }],
      threshold: 2,
      delaySeconds: 0,
      installTxHash: '0x' + 'aa'.repeat(32),
    });
    meta = recordOwnerChange(meta, {
      owner: NEW_OWNER,
      source: 'guardian-recovery',
      txHash: '0x' + 'bb'.repeat(32),
      userOpHash: '0x' + 'cc'.repeat(32),
      blockNumber: '11826400',
      derivationPath: null,
      recordedAt: 1790000100,
    });
    const text = serializeRecoveryMetadata(meta);
    const parsed = parseRecoveryMetadata(text);
    expect(parsed).toEqual(meta);
    expect(serializeRecoveryMetadata(parsed)).toBe(text);
    expect(currentOwnerOf(parsed)).toBe(NEW_OWNER);
    expect(parsed.owners.map((o) => o.source)).toEqual(['deployment', 'guardian-recovery']);
    expect(parsed.guardians!.guardians[0]!.label).toBe('Laptop key');
  });

  it('refuses inconsistent records', () => {
    const good = JSON.parse(serializeRecoveryMetadata(created));
    const bad = (mutate: (v: any) => void) => {
      const v = JSON.parse(JSON.stringify(good));
      mutate(v);
      return () => parseRecoveryMetadata(v);
    };
    expect(bad((v) => (v.account = DEV_OWNER))).toThrow(/does not match the deployment/);
    expect(bad((v) => (v.chainId = '11155111'))).toThrow(/CAIP-2/);
    expect(bad((v) => (v.owners = []))).toThrow(/at least the deployment owner/);
    expect(bad((v) => v.owners.push({ ...v.owners[0], source: 'owner-rotation', owner: NEW_OWNER }))).toThrow(/transaction or UserOperation/);
    expect(bad((v) => v.owners.push({ ...v.owners[0], source: 'owner-rotation', txHash: '0x' + '11'.repeat(32) }))).toThrow(/repeats the previous owner/);
    expect(bad((v) => v.owners.push({ ...v.owners[0], source: 'deployment', owner: NEW_OWNER }))).toThrow(/only the first entry/);
    expect(bad((v) => v.owners.push({ ...v.owners[0], source: 'owner-rotation', owner: '0x0000000000000000000000000000000000000000', txHash: '0x' + '11'.repeat(32) }))).toThrow(/zero address/);
    expect(bad((v) => (v.owners[0].derivationPath = 'not a path'))).toThrow(/BIP-32/);
    // A guardian that is (now) the owner is refused, same rule as at install.
    expect(
      bad((v) => (v.guardians = { weightedEcdsaValidator: KERNEL_RECOVERY_MODULES.weightedEcdsaValidator, recoveryAction: KERNEL_RECOVERY_MODULES.recoveryAction, guardians: [{ address: DEV_OWNER, weight: 1 }], threshold: 1, delaySeconds: 0, installTxHash: null })),
    ).toThrow(/current owner/);
    expect(() => recordOwnerChange(created, { owner: DEV_OWNER, source: 'owner-rotation', txHash: '0x' + '11'.repeat(32), userOpHash: null, blockNumber: null, derivationPath: null, recordedAt: 1 })).toThrow(
      /equals the current owner/,
    );
  });

  it('verifies a record against the chain and reports every mismatch', async () => {
    const { node, chain } = fakeChain();
    expect(await verifyRecoveryMetadataOnChain(node, created)).toEqual({ ok: true, problems: [] });
    chain.owner = NEW_OWNER;
    chain.guardians = [{ address: G1.address, weight: 1 }];
    chain.threshold = 1;
    chain.installed = true;
    const result = await verifyRecoveryMetadataOnChain(node, created);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/owner is/);
    expect(result.problems.join('\n')).toMatch(/not in the record/);
  });
});

describe('inheritance support: roles, delay wrap, approval discovery', () => {
  const created = createRecoveryMetadata({
    chainId: CHAIN_ID,
    account: ACCOUNT,
    index: 2n,
    originalOwner: DEV_OWNER,
    recordedAt: 1790000000,
  });
  const heirRecord = {
    weightedEcdsaValidator: KERNEL_RECOVERY_MODULES.weightedEcdsaValidator,
    recoveryAction: KERNEL_RECOVERY_MODULES.recoveryAction,
    guardians: [{ address: G1.address, weight: 1, label: 'My sister' }],
    threshold: 1,
    delaySeconds: 600,
    installTxHash: null,
  };

  it('keeps records without a role byte-identical and round-trips the heirs role', () => {
    const plain = recordGuardians(created, heirRecord);
    const plainText = serializeRecoveryMetadata(plain);
    expect(plainText).not.toMatch(/"role"/);
    expect(serializeRecoveryMetadata(parseRecoveryMetadata(plainText))).toBe(plainText);
    const heirs = recordGuardians(created, { ...heirRecord, role: 'heirs' });
    const text = serializeRecoveryMetadata(heirs);
    expect(text).toMatch(/"installTxHash":null,"role":"heirs"\}/);
    expect(parseRecoveryMetadata(text).guardians!.role).toBe('heirs');
    expect(serializeRecoveryMetadata(parseRecoveryMetadata(text))).toBe(text);
    const v = JSON.parse(text);
    v.guardians.role = 'executors';
    expect(() => parseRecoveryMetadata(v)).toThrow(/guardians.role must be one of guardians, heirs/);
  });

  it('detects delays whose validAfter would wrap at 2^48', () => {
    const now = 1_791_163_500;
    const max = maxNonWrappingGuardianDelay(now);
    expect(max).toBe(2n ** 48n - 1n - BigInt(now));
    expect(guardianDelayWraps(max, now)).toBe(false);
    expect(guardianDelayWraps(max + 1n, now)).toBe(true);
    expect(guardianDelayWraps(2 ** 48 - 1, now)).toBe(true);
    expect(guardianDelayWraps(365 * 86_400, now)).toBe(false);
    // The validator itself accepts the wrapping delay; the engine refuses it
    // (and everything above MAX_GUARDIAN_DELAY_SECONDS) with the plain sentence.
    expect(() => validateGuardianSet({ guardians: [{ address: G1.address, weight: 1 }], threshold: 1, delaySeconds: 2 ** 48 - 1 })).toThrow(GUARDIAN_DELAY_TOO_LONG);
    expect(() => maxNonWrappingGuardianDelay(2n ** 48n)).toThrow(/out of range/);
  });

  it('refuses every delay that could wrap the uint48 validAfter for any realistic clock', () => {
    const one = (delaySeconds: number) => ({ guardians: [{ address: G1.address, weight: 1 }], threshold: 1, delaySeconds });
    expect(MAX_GUARDIAN_DELAY_SECONDS).toBe(4_294_967_295);
    expect(GUARDIAN_DELAY_TOO_LONG).toBe(
      'delaySeconds must be at most 4294967295 (about 136 years): the guardian validator computes the waiting time as ' +
        'uint48(block.timestamp + delay), and a longer delay could wrap to a time in the past, which would make a takeover valid immediately.',
    );
    // The bound itself and every realistic delay pass; one second more is refused.
    expect(() => validateGuardianSet(one(MAX_GUARDIAN_DELAY_SECONDS))).not.toThrow();
    expect(() => validateGuardianSet(one(365 * 86_400))).not.toThrow();
    expect(() => validateGuardianSet(one(0))).not.toThrow();
    expect(() => validateGuardianSet(one(MAX_GUARDIAN_DELAY_SECONDS + 1))).toThrow(GUARDIAN_DELAY_TOO_LONG);
    // A delay that would wrap for an approval made today, and the S8 value.
    const now = 1_791_163_500;
    expect(() => validateGuardianSet(one(Number(maxNonWrappingGuardianDelay(now)) + 1))).toThrow(GUARDIAN_DELAY_TOO_LONG);
    expect(() => validateGuardianSet(one(2 ** 48 - 1))).toThrow(GUARDIAN_DELAY_TOO_LONG);
    // Why the bound is safe: wrapping at the bound needs a clock past 2^48 - 2^32.
    const firstWrappingTime = 2n ** 48n - BigInt(MAX_GUARDIAN_DELAY_SECONDS);
    expect(firstWrappingTime).toBe(281_470_681_743_361n);
    expect(guardianDelayWraps(MAX_GUARDIAN_DELAY_SECONDS, firstWrappingTime - 1n)).toBe(false);
    expect(guardianDelayWraps(MAX_GUARDIAN_DELAY_SECONDS, firstWrappingTime)).toBe(true);
    // Every entry point that validates refuses before encoding anything.
    expect(() => encodeGuardianSetData(one(2 ** 40))).toThrow(GUARDIAN_DELAY_TOO_LONG);
    expect(() => guardianInstallCalls(ACCOUNT, one(2 ** 40), { owner: DEV_OWNER })).toThrow(GUARDIAN_DELAY_TOO_LONG);
    expect(() => guardianSignatureExposure(one(2 ** 40))).toThrow(GUARDIAN_DELAY_TOO_LONG);
  });

  it('counts the guardian nonce lanes an heir may choose from', () => {
    expect(GUARDIAN_NONCE_LANES).toBe(16_711_680);
  });

  it('decodes approveWithSig and approve calldata like ethers encodes it', () => {
    const iface = new Interface([
      'function approveWithSig(bytes32 _callDataAndNonceHash, address _kernel, bytes sigs)',
      'function approve(bytes32 _callDataAndNonceHash, address _kernel)',
    ]);
    const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: NEW_OWNER, nonce: SDK.nonce });
    const sig1 = signGuardianApproval(G1, toBytes(request.approvalDigest));
    const sig2 = signGuardianApproval(G2, toBytes(request.approvalDigest));
    const engine = encodeApproveWithSig(request, [sig1, sig2]);
    const viaEthers = iface.encodeFunctionData('approveWithSig', [request.callDataAndNonceHash, ACCOUNT, toHex(new Uint8Array([...sig1, ...sig2]))]);
    expect(toHex(engine.data)).toBe(viaEthers);
    const decoded = decodeGuardianApprovalCall(viaEthers)!;
    expect(decoded.kind).toBe('approveWithSig');
    expect(decoded.proposalHash).toBe(lower(request.callDataAndNonceHash));
    expect(decoded.account).toBe(ACCOUNT);
    expect(decoded.signatures.map((x) => toHex(x))).toEqual([toHex(sig1), toHex(sig2)]);
    const approve = decodeGuardianApprovalCall(iface.encodeFunctionData('approve', [request.callDataAndNonceHash, ACCOUNT]))!;
    expect(approve).toEqual({ kind: 'approve', proposalHash: lower(request.callDataAndNonceHash), account: ACCOUNT, signatures: [] });
    // Not an approval, truncated, non-canonical offset, dirty address bits: null, never a guess.
    expect(decodeGuardianApprovalCall(toHex(encodeVetoCall(request.callDataAndNonceHash).data))).toBeNull();
    expect(decodeGuardianApprovalCall(viaEthers.slice(0, 80))).toBeNull();
    const badOffset = viaEthers.slice(0, 10 + 128) + (0x80).toString(16).padStart(64, '0') + viaEthers.slice(10 + 192);
    expect(decodeGuardianApprovalCall(badOffset)).toBeNull();
    const dirty = viaEthers.slice(0, 10 + 64) + 'ff' + viaEthers.slice(10 + 66);
    expect(decodeGuardianApprovalCall(dirty)).toBeNull();
  });

  it('scans full blocks for approvals naming the account and recovers the approvers', async () => {
    const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: NEW_OWNER, nonce: SDK.nonce });
    const other = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: DEV_OWNER === ACCOUNT ? NEW_OWNER : '0x959E8dF4f03033134A791f887209B75aeb13D95a', newOwner: NEW_OWNER, nonce: SDK.nonce });
    const withSig = encodeApproveWithSig(request, [signGuardianApproval(G3, toBytes(request.approvalDigest))]);
    const elsewhere = encodeApproveWithSig(other, [signGuardianApproval(G3, toBytes(other.approvalDigest))]);
    const direct = encodeFunctionCall('approve(bytes32,address)', [
      { kind: 'fixedBytes', value: toBytes(request.callDataAndNonceHash) },
      { kind: 'address', value: ACCOUNT },
    ]);
    const validator = KERNEL_RECOVERY_MODULES.weightedEcdsaValidator;
    const blocks: Record<string, unknown> = {
      '0x64': { transactions: [{ hash: '0x' + '01'.repeat(32), from: NEW_OWNER, to: validator, input: toHex(withSig.data) }] },
      '0x65': {
        transactions: [
          { hash: '0x' + '02'.repeat(32), from: NEW_OWNER, to: validator, input: toHex(elsewhere.data) },
          { hash: '0x' + '03'.repeat(32), from: NEW_OWNER, to: ACCOUNT, input: toHex(withSig.data) },
          { hash: '0x' + '04'.repeat(32), from: G2.address, to: validator, input: toHex(direct) },
        ],
      },
      '0x66': { transactions: [] },
    };
    const calls: string[] = [];
    const node: JsonRpcTransport = async (method, params) => {
      expect(method).toBe('eth_getBlockByNumber');
      expect(params[1]).toBe(true);
      calls.push(params[0] as string);
      return blocks[params[0] as string] ?? null;
    };
    const scan = await scanGuardianApprovals(node, { account: ACCOUNT, chainId: CHAIN_ID, fromBlock: 100n, toBlock: 102n });
    expect(calls.sort()).toEqual(['0x64', '0x65', '0x66']);
    expect(scan.blocksScanned).toBe(3);
    expect(scan.approvals.map((a) => [a.kind, a.txHash, a.blockNumber, a.approvers])).toEqual([
      ['approveWithSig', '0x' + '01'.repeat(32), 100n, [G3.address]],
      ['approve', '0x' + '04'.repeat(32), 101n, [G2.address]],
    ]);
    expect(scan.approvals[0]!.proposalHash).toBe(lower(request.callDataAndNonceHash));
    // Hash-only blocks, missing blocks and oversized ranges are refused, not skipped.
    const hashesOnly: JsonRpcTransport = async () => ({ transactions: ['0x' + '01'.repeat(32)] });
    await expect(scanGuardianApprovals(hashesOnly, { account: ACCOUNT, chainId: CHAIN_ID, fromBlock: 1n, toBlock: 1n })).rejects.toThrow(/hashes, not transactions/);
    const missing: JsonRpcTransport = async () => null;
    await expect(scanGuardianApprovals(missing, { account: ACCOUNT, chainId: CHAIN_ID, fromBlock: 1n, toBlock: 1n })).rejects.toThrow(/was not returned/);
    await expect(
      scanGuardianApprovals(missing, { account: ACCOUNT, chainId: CHAIN_ID, fromBlock: 1n, toBlock: BigInt(MAX_GUARDIAN_APPROVAL_SCAN_BLOCKS) + 1n }),
    ).rejects.toThrow(/at most 2000 blocks/);
  });
});

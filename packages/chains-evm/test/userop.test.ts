import { describe, expect, it } from 'vitest';
import { AbiCoder, getCreate2Address, keccak256 } from 'ethers';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ENTRYPOINT_V07,
  computeCreate2Address,
  getUserOpHash,
  hashUserOperation,
  packPaymasterAndData,
  type UserOperation,
} from '../src/userop.js';
import { keccak, packUint128Pair, toBytes, toHex } from '../src/encoding.js';

const SENDER = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x2222222222222222222222222222222222222222';
const PAYMASTER = '0x3333333333333333333333333333333333333333';

const baseOp: UserOperation = {
  sender: SENDER,
  nonce: 42n,
  factory: FACTORY,
  factoryData: utf8ToBytes('factory-data'),
  callData: utf8ToBytes('call-data'),
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: 60_000n,
  paymasterPostOpGasLimit: 7_000n,
  paymasterData: utf8ToBytes('pm-data'),
  signature: new Uint8Array(65),
};

/**
 * Reference implementation of the EntryPoint v0.7 hash using ethers'
 * AbiCoder — an independent ABI encoder — following UserOperationLib.encode
 * verbatim.
 */
function referenceUserOpHash(op: UserOperation, entryPoint: string, chainId: bigint): string {
  const coder = AbiCoder.defaultAbiCoder();
  const initCode = op.factory
    ? toHex(new Uint8Array([...toBytes(op.factory), ...(op.factoryData ?? [])]))
    : '0x';
  const pmAndData = toHex(packPaymasterAndData(op));
  const accountGasLimits = toHex(
    packUint128Pair(op.verificationGasLimit, op.callGasLimit),
  );
  const gasFees = toHex(packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas));
  const inner = keccak256(
    coder.encode(
      ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
      [
        op.sender,
        op.nonce,
        keccak256(initCode),
        keccak256(toHex(op.callData)),
        accountGasLimits,
        op.preVerificationGas,
        gasFees,
        keccak256(pmAndData),
      ],
    ),
  );
  return keccak256(
    coder.encode(['bytes32', 'address', 'uint256'], [inner, entryPoint, chainId]),
  );
}

describe('EntryPoint v0.7 userOpHash', () => {
  it('matches an independent ethers-based implementation (full op)', () => {
    const ours = toHex(getUserOpHash(baseOp, ENTRYPOINT_V07, 1n));
    expect(ours).toBe(referenceUserOpHash(baseOp, ENTRYPOINT_V07, 1n));
  });

  it('matches for a minimal op with no factory and no paymaster', () => {
    const minimal: UserOperation = {
      ...baseOp,
      factory: undefined,
      factoryData: undefined,
      paymaster: undefined,
      paymasterData: undefined,
      paymasterVerificationGasLimit: undefined,
      paymasterPostOpGasLimit: undefined,
    };
    const ours = toHex(getUserOpHash(minimal, ENTRYPOINT_V07, 8453n));
    expect(ours).toBe(referenceUserOpHash(minimal, ENTRYPOINT_V07, 8453n));
  });

  it('changes when chain id or entry point change (replay protection)', () => {
    const h1 = toHex(getUserOpHash(baseOp, ENTRYPOINT_V07, 1n));
    const h2 = toHex(getUserOpHash(baseOp, ENTRYPOINT_V07, 10n));
    const h3 = toHex(getUserOpHash(baseOp, SENDER, 1n));
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('hashUserOperation is stable for identical inputs', () => {
    expect(bytesToHex(hashUserOperation(baseOp))).toBe(
      bytesToHex(hashUserOperation({ ...baseOp })),
    );
  });
});

describe('paymasterAndData packing (v0.7 offsets 20/36/52)', () => {
  it('lays out address, gas limits, then data', () => {
    const packed = packPaymasterAndData(baseOp);
    expect(toHex(packed.slice(0, 20))).toBe(PAYMASTER);
    // verification gas limit occupies bytes 20..35 (uint128 big-endian)
    const verification = BigInt(toHex(packed.slice(20, 36)));
    const postOp = BigInt(toHex(packed.slice(36, 52)));
    expect(verification).toBe(60_000n);
    expect(postOp).toBe(7_000n);
    expect(new TextDecoder().decode(packed.slice(52))).toBe('pm-data');
  });

  it('is empty without a paymaster', () => {
    expect(packPaymasterAndData({ ...baseOp, paymaster: undefined }).length).toBe(0);
  });
});

describe('CREATE2 counterfactual addresses', () => {
  it('matches ethers.getCreate2Address', () => {
    const salt = keccak(utf8ToBytes('shiba-account-0'));
    const initCodeHash = keccak(utf8ToBytes('some-init-code'));
    const ours = computeCreate2Address(FACTORY, salt, initCodeHash);
    expect(ours).toBe(getCreate2Address(FACTORY, salt, initCodeHash));
  });

  it('rejects malformed salt or hash lengths', () => {
    expect(() => computeCreate2Address(FACTORY, new Uint8Array(31), new Uint8Array(32))).toThrow(
      /salt/,
    );
    expect(() => computeCreate2Address(FACTORY, new Uint8Array(32), new Uint8Array(20))).toThrow(
      /initCodeHash/,
    );
  });
});

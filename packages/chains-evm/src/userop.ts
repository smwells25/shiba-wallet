import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  abiEncodeWords,
  keccak,
  packUint128Pair,
  toBytes,
  toWord,
} from './encoding.js';

/**
 * ERC-4337 UserOperation support targeting EntryPoint v0.7
 * (0x0000000071727De22E5E9d8BAf0edAc6f37da032, the deployment with the
 * widest bundler support). The EntryPoint address and version are explicit
 * parameters everywhere so v0.8+ (EIP-712 hashing) can be added as a
 * parallel strategy without breaking callers (ADR D5: no vendor or version
 * lock-in).
 *
 * Field layout and hash formula verified against
 * eth-infinitism/account-abstraction v0.7.0:
 *  - PackedUserOperation.accountGasLimits = verificationGasLimit (high 128)
 *    || callGasLimit (low 128)
 *  - PackedUserOperation.gasFees = maxPriorityFeePerGas (high 128)
 *    || maxFeePerGas (low 128)
 *  - hash = keccak256(abi.encode(sender, nonce, keccak(initCode),
 *    keccak(callData), accountGasLimits, preVerificationGas, gasFees,
 *    keccak(paymasterAndData)))
 *  - userOpHash = keccak256(abi.encode(hash, entryPoint, chainId))
 */

export const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

/** Developer-friendly (unpacked) UserOperation, as used by bundler RPCs. */
export interface UserOperation {
  sender: string;
  nonce: bigint;
  /** Account factory, set only while the smart account is undeployed. */
  factory?: string;
  factoryData?: Uint8Array;
  callData: Uint8Array;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: string;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Uint8Array;
  signature: Uint8Array;
}

export function packInitCode(op: UserOperation): Uint8Array {
  if (!op.factory) return new Uint8Array(0);
  return concatBytes(toBytes(op.factory), op.factoryData ?? new Uint8Array(0));
}

export function packPaymasterAndData(op: UserOperation): Uint8Array {
  if (!op.paymaster) return new Uint8Array(0);
  return concatBytes(
    toBytes(op.paymaster),
    packUint128Pair(
      op.paymasterVerificationGasLimit ?? 0n,
      op.paymasterPostOpGasLimit ?? 0n,
    ),
    op.paymasterData ?? new Uint8Array(0),
  );
}

/** keccak256(abi.encode(...)) over the packed v0.7 fields, per UserOperationLib. */
export function hashUserOperation(op: UserOperation): Uint8Array {
  return keccak(
    abiEncodeWords([
      toWord(toBytes(op.sender)),
      toWord(op.nonce),
      keccak(packInitCode(op)),
      keccak(op.callData),
      packUint128Pair(op.verificationGasLimit, op.callGasLimit),
      toWord(op.preVerificationGas),
      packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas),
      keccak(packPaymasterAndData(op)),
    ]),
  );
}

/** The digest a smart account's owner key signs (EntryPoint.getUserOpHash). */
export function getUserOpHash(
  op: UserOperation,
  entryPoint: string,
  chainId: bigint,
): Uint8Array {
  return keccak(
    abiEncodeWords([hashUserOperation(op), toWord(toBytes(entryPoint)), toWord(chainId)]),
  );
}

/**
 * Counterfactual contract address via CREATE2:
 * keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:].
 * With a deterministic factory, salt, and account init code, the smart
 * account address exists before any deployment — this is what lets a seed
 * phrase alone recover a smart account (ADR D4).
 */
export function computeCreate2Address(
  deployer: string,
  salt: Uint8Array,
  initCodeHash: Uint8Array,
): string {
  if (salt.length !== 32) throw new Error('CREATE2 salt must be 32 bytes');
  if (initCodeHash.length !== 32) throw new Error('initCodeHash must be 32 bytes');
  const digest = keccak(
    concatBytes(new Uint8Array([0xff]), toBytes(deployer), salt, initCodeHash),
  );
  return toChecksumAddress(digest.slice(12));
}

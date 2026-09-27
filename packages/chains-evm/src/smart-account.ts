import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DerivedAccount } from '@shiba-wallet/core';
import { getUserOpHash, type UserOperation } from './userop.js';
import {
  BundlerClient,
  PaymasterClient,
  type JsonRpcTransport,
} from './rpc.js';

/**
 * Smart-account orchestration: turns "user wants to do X" into a signed
 * UserOperation delivered to a bundler.
 *
 * Account implementations differ (SimpleAccount, Safe, Kernel, Biconomy...)
 * in how they encode calls, compute their counterfactual address, and expect
 * signatures, so those parts are supplied as a SmartAccountSpec. The client
 * owns only the implementation-independent pipeline, which for ERC-4337
 * v0.7 with an ERC-7677 paymaster is:
 *
 *   resolve sender & deployment → encode calls → fill fees & nonce
 *   → paymaster stub → bundler gas estimation → final paymaster data
 *   → sign userOpHash → submit
 */

export interface Call {
  to: string;
  value: bigint;
  data: Uint8Array;
}

export interface SmartAccountSpec {
  /** Counterfactual (CREATE2) address for this owner; stable pre-deployment. */
  getAddress(owner: DerivedAccount): string;
  /** Factory address + calldata that deploy the account, for undeployed senders. */
  getFactoryArgs(owner: DerivedAccount): { factory: string; factoryData: Uint8Array };
  /** Encodes one or more calls into the account's execute/executeBatch calldata. */
  encodeCalls(calls: Call[]): Uint8Array;
  /**
   * Signs the userOpHash the way the account's validation expects (raw hash,
   * EIP-191 wrapped, EIP-1271 envelope...). Given the owner so it can use
   * owner.sign.
   */
  signUserOpHash(owner: DerivedAccount, userOpHash: Uint8Array): Uint8Array;
  /**
   * Placeholder signature of the correct length for gas estimation; bundlers
   * simulate validation, so it must parse without reverting on length.
   */
  stubSignature(): Uint8Array;
}

export interface SmartAccountClientConfig {
  chainId: bigint;
  entryPoint: string;
  /** Bundler RPC transport (eth_sendUserOperation namespace). */
  bundler: JsonRpcTransport;
  /** Node RPC transport, used for nonce and deployment checks. */
  node: JsonRpcTransport;
  /** Optional ERC-7677 paymaster; absent means the account pays its own gas. */
  paymaster?: { transport: JsonRpcTransport; context?: unknown };
  spec: SmartAccountSpec;
}

/** getNonce(address,uint192) selector on the EntryPoint (nonce manager). */
const GET_NONCE_SELECTOR = keccak_256(utf8ToBytes('getNonce(address,uint192)')).slice(0, 4);

export class SmartAccountClient {
  private bundlerClient: BundlerClient;
  private paymasterClient?: PaymasterClient;

  constructor(private config: SmartAccountClientConfig) {
    this.bundlerClient = new BundlerClient(config.bundler, config.entryPoint);
    if (config.paymaster) {
      this.paymasterClient = new PaymasterClient(
        config.paymaster.transport,
        config.entryPoint,
      );
    }
  }

  getAddress(owner: DerivedAccount): string {
    return this.config.spec.getAddress(owner);
  }

  /** True once the account contract exists on chain. */
  async isDeployed(owner: DerivedAccount): Promise<boolean> {
    const code = (await this.config.node('eth_getCode', [
      this.getAddress(owner),
      'latest',
    ])) as string;
    return code !== undefined && code !== '0x' && code !== '0x0';
  }

  /** Reads the account's ERC-4337 nonce (key 0) from the EntryPoint. */
  async getNonce(owner: DerivedAccount): Promise<bigint> {
    const sender = this.getAddress(owner);
    const data = new Uint8Array(4 + 32 + 32);
    data.set(GET_NONCE_SELECTOR, 0);
    // address argument, left-padded to a 32-byte word
    const addressBytes = hexToBytesStrict(sender);
    data.set(addressBytes, 4 + 12);
    // uint192 key argument stays zero
    const result = (await this.config.node('eth_call', [
      { to: this.config.entryPoint, data: bytesToHexStrict(data) },
      'latest',
    ])) as string;
    return BigInt(result);
  }

  /**
   * Builds, sponsors (if configured), estimates, and signs a UserOperation
   * for the given calls, then submits it. Returns the userOpHash.
   */
  async sendCalls(
    owner: DerivedAccount,
    calls: Call[],
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ): Promise<{ userOpHash: string; userOp: UserOperation }> {
    const spec = this.config.spec;
    const deployed = await this.isDeployed(owner);
    const factoryArgs = deployed ? undefined : spec.getFactoryArgs(owner);

    let op: UserOperation = {
      sender: this.getAddress(owner),
      nonce: await this.getNonce(owner),
      ...(factoryArgs
        ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData }
        : {}),
      callData: spec.encodeCalls(calls),
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signature: spec.stubSignature(),
    };

    // ERC-7677 two-phase flow: stub data makes gas estimation realistic,
    // final data is requested once gas limits are known.
    if (this.paymasterClient) {
      const stub = await this.paymasterClient.getPaymasterStubData(
        op,
        this.config.chainId,
        this.config.paymaster!.context ?? null,
      );
      op = { ...op, ...paymasterFields(stub) };
    }

    const gas = await this.bundlerClient.estimateUserOperationGas(op);
    op = {
      ...op,
      callGasLimit: gas.callGasLimit,
      verificationGasLimit: gas.verificationGasLimit,
      preVerificationGas: gas.preVerificationGas,
      ...(gas.paymasterVerificationGasLimit !== undefined
        ? { paymasterVerificationGasLimit: gas.paymasterVerificationGasLimit }
        : {}),
    };

    if (this.paymasterClient) {
      const finalData = await this.paymasterClient.getPaymasterData(
        op,
        this.config.chainId,
        this.config.paymaster!.context ?? null,
      );
      op = { ...op, ...paymasterFields(finalData) };
    }

    const hash = getUserOpHash(op, this.config.entryPoint, this.config.chainId);
    op = { ...op, signature: spec.signUserOpHash(owner, hash) };

    const userOpHash = await this.bundlerClient.sendUserOperation(op);
    return { userOpHash, userOp: op };
  }

  async waitForReceipt(
    userOpHash: string,
    { timeoutMs = 60_000, pollMs = 2_000 }: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.bundlerClient.getUserOperationReceipt(userOpHash);
      if (receipt) return receipt;
      if (Date.now() + pollMs > deadline) {
        throw new Error(`Timed out waiting for UserOperation ${userOpHash}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

function paymasterFields(result: {
  paymaster: string;
  paymasterData: Uint8Array;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}): Partial<UserOperation> {
  return {
    paymaster: result.paymaster,
    paymasterData: result.paymasterData,
    ...(result.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: result.paymasterVerificationGasLimit }
      : {}),
    ...(result.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: result.paymasterPostOpGasLimit }
      : {}),
  };
}

/**
 * EIP-191 "personal message" wrapping of a 32-byte digest:
 * keccak256("\x19Ethereum Signed Message:\n32" || digest). Several account
 * implementations validate owner signatures over this form; specs can use it
 * from their signUserOpHash.
 */
export function toEthSignedMessageHash(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error('Digest must be 32 bytes');
  return keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n32'), digest));
}

/**
 * Converts a core r||s||recid signature (recid 0/1) to the r||s||v form with
 * v = 27 + recid that ecrecover-based validation expects.
 */
export function withEthereumV(signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) throw new Error('Expected a 65-byte recoverable signature');
  const out = signature.slice();
  const recid = out[64]!;
  if (recid === 0 || recid === 1) out[64] = recid + 27;
  else if (recid !== 27 && recid !== 28) throw new Error(`Unexpected recovery byte ${recid}`);
  return out;
}

function hexToBytesStrict(hex: string): Uint8Array {
  if (!hex.startsWith('0x')) throw new Error(`Expected 0x hex: ${hex}`);
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexStrict(bytes: Uint8Array): string {
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

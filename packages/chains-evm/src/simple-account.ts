import type { DerivedAccount } from '@shiba-wallet/core';
import { encodeFunctionCall } from './abi.js';
import { toEthSignedMessageHash, withEthereumV } from './smart-account.js';
import type { Call, SmartAccountSpec } from './smart-account.js';
import type { JsonRpcTransport } from './rpc.js';
import { toBytes, toHex } from './encoding.js';
import { toChecksumAddress } from '@shiba-wallet/core';

/**
 * SmartAccountSpec for the canonical eth-infinitism SimpleAccount (v0.7
 * samples). Facts verified against account-abstraction v0.7.0 sources:
 *  - SimpleAccountFactory.createAccount(address owner, uint256 salt)
 *  - SimpleAccountFactory.getAddress(address owner, uint256 salt) view
 *  - SimpleAccount.execute(address dest, uint256 value, bytes func)
 *  - SimpleAccount.executeBatch(address[] dest, uint256[] value, bytes[] func)
 *  - _validateSignature recovers the owner from
 *    toEthSignedMessageHash(userOpHash), so the owner signs the EIP-191
 *    wrapped hash with v = 27/28.
 *
 * The counterfactual address is read from the factory's getAddress view via
 * eth_call rather than recomputed locally: it is authoritative for whatever
 * factory deployment is configured, and avoids pinning compiler-dependent
 * proxy bytecode. Results are cached per owner (deterministic).
 */
export interface SimpleAccountConfig {
  /** Deployed SimpleAccountFactory address for the target chain. */
  factory: string;
  /** Node RPC transport used for the getAddress view call. */
  node: JsonRpcTransport;
  /** CREATE2 salt; same owner + different salt = independent account. */
  salt?: bigint;
}

export function createSimpleAccountSpec(config: SimpleAccountConfig): SmartAccountSpec {
  const salt = config.salt ?? 0n;
  const addressCache = new Map<string, string>();

  return {
    async getAddress(owner: DerivedAccount): Promise<string> {
      const cached = addressCache.get(owner.address);
      if (cached) return cached;
      const data = encodeFunctionCall('getAddress(address,uint256)', [
        { kind: 'address', value: owner.address },
        { kind: 'uint256', value: salt },
      ]);
      const result = (await config.node('eth_call', [
        { to: config.factory, data: toHex(data) },
        'latest',
      ])) as string;
      const word = toBytes(result);
      if (word.length !== 32) {
        throw new Error(`Factory getAddress returned ${word.length} bytes, expected 32`);
      }
      const address = toChecksumAddress(word.slice(12));
      addressCache.set(owner.address, address);
      return address;
    },

    async getFactoryArgs(owner: DerivedAccount) {
      return {
        factory: config.factory,
        factoryData: encodeFunctionCall('createAccount(address,uint256)', [
          { kind: 'address', value: owner.address },
          { kind: 'uint256', value: salt },
        ]),
      };
    },

    encodeCalls(calls: Call[]): Uint8Array {
      if (calls.length === 0) throw new Error('At least one call is required');
      if (calls.length === 1) {
        const call = calls[0]!;
        return encodeFunctionCall('execute(address,uint256,bytes)', [
          { kind: 'address', value: call.to },
          { kind: 'uint256', value: call.value },
          { kind: 'bytes', value: call.data },
        ]);
      }
      return encodeFunctionCall('executeBatch(address[],uint256[],bytes[])', [
        { kind: 'array', items: calls.map((c) => ({ kind: 'address' as const, value: c.to })) },
        { kind: 'array', items: calls.map((c) => ({ kind: 'uint256' as const, value: c.value })) },
        { kind: 'array', items: calls.map((c) => ({ kind: 'bytes' as const, value: c.data })) },
      ]);
    },

    signUserOpHash(owner: DerivedAccount, userOpHash: Uint8Array): Uint8Array {
      return withEthereumV(owner.sign(toEthSignedMessageHash(userOpHash)));
    },

    stubSignature(): Uint8Array {
      // 65 bytes shaped like a real ECDSA signature so simulation parses it.
      const stub = new Uint8Array(65).fill(0x01);
      stub[64] = 27;
      return stub;
    },
  };
}

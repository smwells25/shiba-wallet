import type { DerivedAccount } from '@shiba-wallet/core';
import { wrapErc6492Signature } from './erc6492.js';
import type { JsonRpcTransport } from './rpc.js';
import type { SmartAccountSpec } from './smart-account.js';

/**
 * Smart-account message signing (phase 7 item 3): produces the signature a
 * dApp receives when a smart-account user signs a message or typed data,
 * so the dApp can verify it with ERC-1271 (deployed account) or ERC-6492
 * (counterfactual account).
 *
 * `hash` is what the verifier will pass to isValidSignature: for
 * personal_sign the EIP-191 hash of the message (hashEip191Message), for
 * eth_signTypedData_v4 the EIP-712 digest (typedDataDigest). The account
 * spec's signErc1271 applies the framework's envelope (for Kernel v3.3: the
 * Kernel(bytes32) rehash under the account's own domain plus the validator
 * prefix). When the account has no code yet, the result is wrapped per
 * ERC-6492 with the spec's own factory arguments — the same ones a
 * deployment UserOperation would use — so verifiers can simulate the
 * deployment first.
 *
 * Accounts whose implementation has no ERC-1271 support (the
 * eth-infinitism SimpleAccount v0.7.0 sample) leave signErc1271 undefined,
 * and this function refuses: a raw owner-EOA signature would verify
 * against the OWNER address, not the smart account, and must never be
 * presented as the account's signature.
 */
export interface SmartAccountSignature {
  /** The smart account address the signature is for. */
  account: string;
  /** Bytes to hand to the dApp. */
  signature: Uint8Array;
  /** Whether the account had code at signing time. */
  deployed: boolean;
  /** Whether the signature is ERC-6492 wrapped. */
  erc6492: boolean;
}

export async function signHashForSmartAccount(
  spec: SmartAccountSpec,
  owner: DerivedAccount,
  hash: Uint8Array,
  options: { chainId: bigint; node: JsonRpcTransport; blockTag?: string },
): Promise<SmartAccountSignature> {
  if (!spec.signErc1271) {
    throw new Error(
      'This smart-account implementation does not support ERC-1271 signatures, ' +
        'so it cannot sign messages for dApps.',
    );
  }
  if (hash.length !== 32) throw new Error(`hash must be 32 bytes, got ${hash.length}`);
  const account = await spec.getAddress(owner);
  const code = await options.node('eth_getCode', [account, options.blockTag ?? 'latest']);
  const deployed = typeof code === 'string' && code !== '0x' && code !== '0x0' && code !== '';
  const inner = spec.signErc1271(owner, hash, { chainId: options.chainId, account });
  if (deployed) return { account, signature: inner, deployed, erc6492: false };
  const { factory, factoryData } = await spec.getFactoryArgs(owner);
  return {
    account,
    signature: wrapErc6492Signature({ factory, factoryData, signature: inner }),
    deployed,
    erc6492: true,
  };
}

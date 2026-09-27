import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ChainKeyProvider, DerivedAccount } from './types.js';

/**
 * EVM chain family key provider (Ethereum and every eip155 chain).
 *
 * One derived EOA key serves two roles:
 *  1. A plain externally-owned account (and the EIP-7702 upgrade path).
 *  2. The owner/signer of a counterfactual ERC-4337 smart account, whose
 *     address is computed via CREATE2 from a factory + owner + salt. Because
 *     the owner key derives from the wallet seed, the seed phrase alone
 *     recovers smart accounts as well (project decision D1). Smart-account
 *     address computation lives in @shiba-wallet/chains-evm, since it depends
 *     on the chosen factory contract, not on key material.
 */
export const SLIP44_ETH = 60;

/** EIP-55 mixed-case checksum encoding of a 20-byte address. */
export function toChecksumAddress(addressBytes: Uint8Array): string {
  if (addressBytes.length !== 20) throw new Error('EVM address must be 20 bytes');
  const lower = bytesToHex(addressBytes);
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

export function publicKeyToEvmAddress(privateKey: Uint8Array): string {
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  const addressBytes = keccak_256(uncompressed.slice(1)).slice(-20);
  return toChecksumAddress(addressBytes);
}

export const evmKeyProvider: ChainKeyProvider = {
  chainId: 'eip155:1',
  coinType: SLIP44_ETH,
  curve: 'secp256k1',
  name: 'Ethereum',

  derivationPath(account: number, addressIndex: number): string {
    return `m/44'/${SLIP44_ETH}'/${account}'/0/${addressIndex}`;
  },

  deriveAccount(seed: Uint8Array, account: number, addressIndex: number): DerivedAccount {
    const path = this.derivationPath(account, addressIndex);
    const node = HDKey.fromMasterSeed(seed).derive(path);
    const privateKey = node.privateKey;
    if (!privateKey || !node.publicKey) throw new Error('Derivation produced no key');
    return {
      chainId: this.chainId,
      path,
      publicKey: node.publicKey,
      address: publicKeyToEvmAddress(privateKey),
      // noble's 'recovered' format is recoveryByte || r || s; EVM expects
      // r || s || recoveryByte (65 bytes), so reorder before returning.
      sign: (digest: Uint8Array) => {
        const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered' });
        const out = new Uint8Array(65);
        out.set(sig.subarray(1), 0);
        out[64] = sig[0]!;
        return out;
      },
    };
  },
};

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

/**
 * True when `privateKey` is a usable secp256k1 private key: exactly 32
 * bytes whose big-endian value is in [1, n - 1], where n is the curve
 * order. Delegates to @noble/curves' own check (secp256k1.utils
 * .isValidSecretKey), which rejects zero, values at or above n, and any
 * other length.
 */
export function isValidEvmPrivateKey(privateKey: Uint8Array): boolean {
  return privateKey.length === 32 && secp256k1.utils.isValidSecretKey(privateKey);
}

/**
 * The EVM signing closure shared by derived and imported keys: an ECDSA
 * signature over a 32-byte digest, returned as r || s || recovery byte
 * (65 bytes), which is the layout EVM consumers expect. noble's
 * 'recovered' format is recovery byte || r || s, so it is reordered here.
 */
function evmSigner(privateKey: Uint8Array): (digest: Uint8Array) => Uint8Array {
  return (digest: Uint8Array) => {
    const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered' });
    const out = new Uint8Array(65);
    out.set(sig.subarray(1), 0);
    out[64] = sig[0]!;
    return out;
  };
}

/**
 * An EVM account for a private key that does NOT come from the wallet's
 * seed (a key the user imported). It signs exactly like an account from
 * evmKeyProvider.deriveAccount, but it has no derivation path: `path` is
 * the caller's label (the app uses a fixed non-BIP-32 marker), so code that
 * records BIP-32 paths can recognise and skip it. Throws on an invalid key.
 * The closure keeps a reference to `privateKey`; the caller owns the buffer
 * and may zero it after the signing operation.
 */
export function evmAccountFromPrivateKey(privateKey: Uint8Array, path: string): DerivedAccount {
  if (!isValidEvmPrivateKey(privateKey)) {
    throw new Error('Not a valid secp256k1 private key (32 bytes, in the range 1 to n - 1)');
  }
  return {
    chainId: evmKeyProvider.chainId,
    path,
    publicKey: secp256k1.getPublicKey(privateKey, true),
    address: publicKeyToEvmAddress(privateKey),
    sign: evmSigner(privateKey),
  };
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
      sign: evmSigner(privateKey),
    };
  },
};

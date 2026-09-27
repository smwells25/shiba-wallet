import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { base58check, bech32 } from '@scure/base';
import type { ChainKeyProvider, DerivedAccount } from './types.js';

/**
 * UTXO chain family: Bitcoin, Dogecoin, and the many Bitcoin-derived chains
 * (Litecoin etc.) differ only in derivation coin type, address version bytes,
 * and bech32 prefix, so one factory covers the whole family.
 */

export function hash160(publicKey: Uint8Array): Uint8Array {
  return ripemd160(sha256(publicKey));
}

const b58c = base58check(sha256);

/** Legacy pay-to-pubkey-hash address (Dogecoin "D...", Bitcoin "1..."). */
export function p2pkhAddress(publicKey: Uint8Array, versionByte: number): string {
  return b58c.encode(concatBytes(new Uint8Array([versionByte]), hash160(publicKey)));
}

/** Native segwit v0 pay-to-witness-pubkey-hash address (Bitcoin "bc1q..."). */
export function p2wpkhAddress(publicKey: Uint8Array, hrp: string): string {
  const words = bech32.toWords(hash160(publicKey));
  return bech32.encode(hrp, [0, ...words]);
}

export interface UtxoChainConfig {
  chainId: string;
  name: string;
  coinType: number;
  /** BIP-44 (legacy p2pkh) or BIP-84 (native segwit p2wpkh). */
  purpose: 44 | 84;
  /** p2pkh version byte, used when purpose is 44. */
  p2pkhVersion?: number;
  /** bech32 human-readable prefix, used when purpose is 84. */
  bech32Hrp?: string;
}

export function createUtxoKeyProvider(config: UtxoChainConfig): ChainKeyProvider {
  return {
    chainId: config.chainId,
    coinType: config.coinType,
    curve: 'secp256k1',
    name: config.name,

    derivationPath(account: number, addressIndex: number): string {
      return `m/${config.purpose}'/${config.coinType}'/${account}'/0/${addressIndex}`;
    },

    deriveAccount(seed: Uint8Array, account: number, addressIndex: number): DerivedAccount {
      const path = this.derivationPath(account, addressIndex);
      const node = HDKey.fromMasterSeed(seed).derive(path);
      const privateKey = node.privateKey;
      const publicKey = node.publicKey;
      if (!privateKey || !publicKey) throw new Error('Derivation produced no key');

      let address: string;
      if (config.purpose === 84) {
        if (!config.bech32Hrp) throw new Error(`${config.name}: bech32Hrp required for BIP-84`);
        address = p2wpkhAddress(publicKey, config.bech32Hrp);
      } else {
        if (config.p2pkhVersion === undefined) {
          throw new Error(`${config.name}: p2pkhVersion required for BIP-44`);
        }
        address = p2pkhAddress(publicKey, config.p2pkhVersion);
      }

      return {
        chainId: config.chainId,
        path,
        publicKey,
        address,
        // Compact r || s over a sighash digest, DER-encoded by the tx builder.
        sign: (digest: Uint8Array) =>
          secp256k1.sign(digest, privateKey, { prehash: false, format: 'compact' }),
      };
    },
  };
}

/** Bitcoin mainnet, native segwit (BIP-84). CAIP-2 bip122 genesis-hash id. */
export const bitcoinKeyProvider = createUtxoKeyProvider({
  chainId: 'bip122:000000000019d6689c085ae165831e93',
  name: 'Bitcoin',
  coinType: 0,
  purpose: 84,
  bech32Hrp: 'bc',
});

/**
 * Dogecoin mainnet, legacy p2pkh (Dogecoin has no segwit). Version byte 30
 * (0x1e, "D" prefix) and the genesis hash behind the bip122 identifier are
 * taken from dogecoin/dogecoin src/chainparams.cpp (mainnet):
 * PUBKEY_ADDRESS = 30, genesis 1a91e3dace36e2be3bf030a65679fe82...
 */
export const dogecoinKeyProvider = createUtxoKeyProvider({
  chainId: 'bip122:1a91e3dace36e2be3bf030a65679fe82',
  name: 'Dogecoin',
  coinType: 3,
  purpose: 44,
  p2pkhVersion: 0x1e,
});

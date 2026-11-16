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
 * Bitcoin SIGNET, native segwit (BIP-84), for the app's "Use Bitcoin
 * signet" switch (phase 28 item 2). Every value is sourced:
 *  - chainId: CAIP-2 bip122 references are "a 32-character prefix from the
 *    hash of the genesis block of a given chain, in lowercase hex"
 *    (ChainAgnostic/namespaces bip122/caip2.md, read 2026-11-16 at head
 *    2a9193da, lines 25-26 and 50-53). Signet's genesis block hash is
 *    00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6
 *    (bitcoin/bitcoin src/kernel/chainparams.cpp class SigNetParams, the
 *    assert on consensus.hashGenesisBlock, line 539 at head 8130b3b8, read
 *    2026-11-16), so the reference is its first 32 characters. Every signet
 *    (the default one and any custom-challenge signet) shares that genesis
 *    block (the same CreateGenesisBlock call, line 537), so this id does
 *    not tell the default signet from a custom one; the app's default
 *    endpoints serve the default signet (their providers' own pages).
 *  - coinType 1: BIP-44 "Registered coin types" lists index 1, hexa
 *    0x80000001, "Bitcoin Testnet" (bitcoin/bips bip-0044.mediawiki lines
 *    148-150 at head c0614759) and its example table derives
 *    m/44'/1'/0'/0/0 for "Bitcoin Testnet" (line 222); SLIP-44 registers 1 as "Testnet (all coins)"
 *    (satoshilabs/slips slip-0044.md line 34 at head 7a2abdd1). BIP-84
 *    keeps BIP-44's levels, m / purpose' / coin_type' / account' / change /
 *    address_index (bip-0084.mediawiki line 38). The repository's own
 *    testnet scripts use coin type 1 as well (scripts/testnet/setup.mjs,
 *    smoke.mjs). Using 1, not 0, means a signet address is NOT the mainnet
 *    address of the same account re-encoded: posting one never reveals the
 *    other.
 *  - bech32Hrp "tb": chainparams.cpp SigNetParams bech32_hrp (line 569).
 */
export const bitcoinSignetKeyProvider = createUtxoKeyProvider({
  chainId: 'bip122:00000008819873e925422c1ff0f99f7c',
  name: 'Bitcoin signet',
  coinType: 1,
  purpose: 84,
  bech32Hrp: 'tb',
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

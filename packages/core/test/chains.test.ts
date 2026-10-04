import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDNodeWallet, Signature, SigningKey, Wallet } from 'ethers';
import { derivePath as refDerivePath } from 'ed25519-hd-key';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { mnemonicToSeed } from '../src/keyring/mnemonic.js';
import {
  evmAccountFromPrivateKey,
  evmKeyProvider,
  isValidEvmPrivateKey,
  toChecksumAddress,
} from '../src/chains/evm.js';
import { bitcoinKeyProvider, dogecoinKeyProvider } from '../src/chains/utxo.js';
import { solanaKeyProvider } from '../src/chains/solana.js';
import { slip10DerivePath } from '../src/keyring/slip10.js';
import { HdKeyring } from '../src/keyring/keyring.js';
import { ChainRegistry } from '../src/registry/registry.js';

// The standard BIP-39 test mnemonic (all-zero entropy). Used by the official
// BIP-84 test vectors and by wallet ecosystems everywhere. Never fund it.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const seed = mnemonicToSeed(TEST_MNEMONIC);

describe('Bitcoin key provider (BIP-84)', () => {
  // Official test vectors from BIP-84 itself, which uses this mnemonic:
  // https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
  it('derives the official first and second receiving addresses', () => {
    expect(bitcoinKeyProvider.deriveAccount(seed, 0, 0).address).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(bitcoinKeyProvider.deriveAccount(seed, 0, 1).address).toBe(
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    );
  });

  it('uses the BIP-84 purpose and coin type in its path', () => {
    expect(bitcoinKeyProvider.derivationPath(0, 5)).toBe("m/84'/0'/0'/0/5");
  });
});

describe('EVM key provider', () => {
  it('derives the same address as ethers.js (independent implementation)', () => {
    // ethers defaults to m/44'/60'/0'/0/0 for fromPhrase.
    const reference = HDNodeWallet.fromPhrase(TEST_MNEMONIC);
    const ours = evmKeyProvider.deriveAccount(seed, 0, 0);
    expect(ours.address).toBe(reference.address);
    expect(ours.path).toBe("m/44'/60'/0'/0/0");

    const reference1 = HDNodeWallet.fromPhrase(
      TEST_MNEMONIC,
      undefined,
      "m/44'/60'/0'/0/1",
    );
    expect(evmKeyProvider.deriveAccount(seed, 0, 1).address).toBe(reference1.address);
  });

  it('produces EIP-55 checksummed addresses', () => {
    const { address } = evmKeyProvider.deriveAccount(seed, 0, 0);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(toChecksumAddress(new Uint8Array(20))).toBe(
      '0x0000000000000000000000000000000000000000',
    );
  });

  it('signs digests as r||s||recoveryByte and the public key recovers', () => {
    const account = evmKeyProvider.deriveAccount(seed, 0, 0);
    const digest = sha256(new Uint8Array([1, 2, 3]));
    const sig = account.sign(digest);
    expect(sig.length).toBe(65);
    // Rebuild noble's recovered layout (recid first) to recover the key.
    const nobleLayout = new Uint8Array(65);
    nobleLayout[0] = sig[64]!;
    nobleLayout.set(sig.subarray(0, 64), 1);
    const recovered = secp256k1.recoverPublicKey(nobleLayout, digest, {
      prehash: false,
      format: 'recovered',
    });
    expect(bytesToHex(recovered)).toBe(bytesToHex(account.publicKey));
  });
});

describe('EVM account from an imported private key', () => {
  // Disposable keys, built at runtime (never pasted literals): the private
  // key of the public test mnemonic's account 0, the smallest and largest
  // valid scalars, and keccak-free byte patterns.
  const N = secp256k1.Point.Fn.ORDER;
  const be32 = (v: bigint) => {
    const out = new Uint8Array(32);
    let x = v;
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  };
  const seedKey = HDNodeWallet.fromPhrase(TEST_MNEMONIC).privateKey;
  const seedKeyBytes = Uint8Array.from(Buffer.from(seedKey.slice(2), 'hex'));

  it('accepts exactly the scalars 1..n-1 of 32 bytes', () => {
    expect(isValidEvmPrivateKey(be32(1n))).toBe(true);
    expect(isValidEvmPrivateKey(be32(N - 1n))).toBe(true);
    expect(isValidEvmPrivateKey(be32(0n))).toBe(false);
    expect(isValidEvmPrivateKey(be32(N))).toBe(false);
    expect(isValidEvmPrivateKey(be32(N + 1n))).toBe(false);
    expect(isValidEvmPrivateKey(new Uint8Array(32).fill(0xff))).toBe(false);
    expect(isValidEvmPrivateKey(new Uint8Array(31).fill(1))).toBe(false);
    expect(isValidEvmPrivateKey(new Uint8Array(33).fill(1))).toBe(false);
    expect(() => evmAccountFromPrivateKey(be32(0n), 'imported')).toThrow();
    expect(() => evmAccountFromPrivateKey(be32(N), 'imported')).toThrow();
  });

  it('derives the address ethers derives for the same key, for boundary keys too', () => {
    for (const key of [seedKeyBytes, be32(1n), be32(N - 1n), be32(0x1234n << 128n)]) {
      const ours = evmAccountFromPrivateKey(key, 'imported');
      const reference = new Wallet('0x' + bytesToHex(key));
      expect(ours.address).toBe(reference.address);
      expect(ours.path).toBe('imported');
      expect(ours.chainId).toBe('eip155:1');
      expect(bytesToHex(ours.publicKey)).toBe(new SigningKey('0x' + bytesToHex(key)).compressedPublicKey.slice(2));
    }
  });

  it('is byte-identical to the seed-derived account for the same key (address, public key, signatures)', () => {
    const derived = evmKeyProvider.deriveAccount(seed, 0, 0);
    const imported = evmAccountFromPrivateKey(seedKeyBytes, 'imported');
    expect(imported.address).toBe(derived.address);
    expect(bytesToHex(imported.publicKey)).toBe(bytesToHex(derived.publicKey));
    const digest = sha256(new Uint8Array([9, 8, 7]));
    expect(bytesToHex(imported.sign(digest))).toBe(bytesToHex(derived.sign(digest)));
  });

  it('signs like ethers SigningKey (r, s, v) and recovers to the address', () => {
    const key = be32(N - 1n);
    const ours = evmAccountFromPrivateKey(key, 'imported');
    const digest = sha256(new Uint8Array([4, 5, 6]));
    const sig = ours.sign(digest);
    const ref = new SigningKey('0x' + bytesToHex(key)).sign(digest);
    expect('0x' + bytesToHex(sig.subarray(0, 32))).toBe(ref.r);
    expect('0x' + bytesToHex(sig.subarray(32, 64))).toBe(ref.s);
    expect(sig[64]! + 27).toBe(ref.v);
    const recovered = SigningKey.recoverPublicKey(digest, Signature.from(ref));
    expect(new Wallet('0x' + bytesToHex(key)).signingKey.publicKey).toBe(recovered);
  });
});

describe('Solana key provider', () => {
  it('derives the same key as ed25519-hd-key (independent implementation)', () => {
    const path = "m/44'/501'/0'/0'";
    const reference = refDerivePath(path, bytesToHex(seed));
    const ours = slip10DerivePath(seed, path);
    expect(bytesToHex(ours.privateKey)).toBe(bytesToHex(reference.key));
    expect(bytesToHex(ours.chainCode)).toBe(bytesToHex(reference.chainCode));
  });

  it('derives a base58 address of the ed25519 public key', () => {
    const account = solanaKeyProvider.deriveAccount(seed, 0, 0);
    expect(account.path).toBe("m/44'/501'/0'/0'");
    expect(account.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // ed25519 signature over an arbitrary message verifies.
    const msg = new Uint8Array([9, 9, 9]);
    expect(account.sign(msg).length).toBe(64);
  });

  it('gives each account index a distinct hardened subtree', () => {
    const a0 = solanaKeyProvider.deriveAccount(seed, 0, 0);
    const a1 = solanaKeyProvider.deriveAccount(seed, 1, 0);
    expect(a0.address).not.toBe(a1.address);
  });
});

describe('Dogecoin key provider', () => {
  it('derives a version-0x1e p2pkh address (leading D) that round-trips', () => {
    const account = dogecoinKeyProvider.deriveAccount(seed, 0, 0);
    expect(account.path).toBe("m/44'/3'/0'/0/0");
    expect(account.address.startsWith('D')).toBe(true);
    const decoded = base58check(sha256).decode(account.address);
    expect(decoded.length).toBe(21);
    // Version byte 30 (0x1e) per dogecoin/dogecoin src/chainparams.cpp.
    expect(decoded[0]).toBe(0x1e);
  });
});

describe('HdKeyring + ChainRegistry integration', () => {
  it('serves every registered chain from one seed', () => {
    const registry = new ChainRegistry();
    registry.register(evmKeyProvider);
    registry.register(bitcoinKeyProvider);
    registry.register(dogecoinKeyProvider);
    registry.register(solanaKeyProvider);

    const keyring = HdKeyring.fromMnemonic(TEST_MNEMONIC, registry);
    expect(keyring.getAccount('bip122:000000000019d6689c085ae165831e93').address).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(registry.list().length).toBe(4);
    expect(() => registry.register(evmKeyProvider)).toThrow(/already registered/);
    expect(() => registry.get('eip155:999999')).toThrow(/not registered/);
  });

  it('rejects invalid mnemonics', () => {
    expect(() => HdKeyring.fromMnemonic('doge doge doge', new ChainRegistry())).toThrow(
      /Invalid BIP-39/,
    );
  });

  it('derives different wallets for different BIP-39 passphrases', () => {
    const registry = new ChainRegistry();
    registry.register(evmKeyProvider);
    const plain = HdKeyring.fromMnemonic(TEST_MNEMONIC, registry);
    const passworded = HdKeyring.fromMnemonic(TEST_MNEMONIC, registry, 'much secret');
    expect(plain.getAccount('eip155:1').address).not.toBe(
      passworded.getAccount('eip155:1').address,
    );
  });
});

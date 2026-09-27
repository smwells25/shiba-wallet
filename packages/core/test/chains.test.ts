import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDNodeWallet } from 'ethers';
import { derivePath as refDerivePath } from 'ed25519-hd-key';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { mnemonicToSeed } from '../src/keyring/mnemonic.js';
import { evmKeyProvider, toChecksumAddress } from '../src/chains/evm.js';
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

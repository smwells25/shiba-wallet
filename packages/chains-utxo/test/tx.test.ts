import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  hash160,
  mnemonicToSeed,
} from '@shiba-wallet/core';
import { addressToScriptPubKey, BITCOIN, DOGECOIN, p2wpkhScript } from '../src/address.js';
import { bytesToHex } from '../src/encoding.js';
import {
  serializeTransaction,
  signTransaction,
  transactionId,
  type UnsignedTransaction,
} from '../src/tx.js';

/**
 * Cross-checks against bitcoinjs-lib: the same keys, UTXOs, and outputs are
 * fed to our builder and to bitcoinjs-lib's Psbt. Both sign with
 * deterministic RFC-6979 nonces (bitcoinjs is handed a noble-based signer),
 * so if our sighash preimages and serialization are correct, the fully
 * signed transactions must be byte-identical, not merely txid-identical.
 */

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const root = HDKey.fromMasterSeed(seed);

/** Private key + a bitcoinjs Signer backed by the same noble signing call. */
function keyAt(path: string) {
  const node = root.derive(path);
  if (!node.privateKey || !node.publicKey) throw new Error('no key');
  const privateKey = node.privateKey;
  const publicKey = node.publicKey;
  return {
    publicKey,
    privateKey,
    /** Our InputSigner shape (compact 64-byte r||s, low-S, deterministic). */
    signer: {
      publicKey,
      sign: (digest: Uint8Array) =>
        secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, format: 'compact' }),
    },
    /** bitcoinjs-lib Signer over the identical noble primitive. */
    bjsSigner: {
      publicKey: Buffer.from(publicKey),
      sign: (hash: Buffer) =>
        Buffer.from(
          secp256k1.sign(Uint8Array.from(hash), privateKey, {
            prehash: false,
            lowS: true,
            format: 'compact',
          }),
        ),
    },
  };
}

describe('P2WPKH (Bitcoin, BIP-143) vs bitcoinjs-lib', () => {
  const account = bitcoinKeyProvider.deriveAccount(seed, 0, 0);
  const key = keyAt(bitcoinKeyProvider.derivationPath(0, 0));
  const recipient = bitcoinKeyProvider.deriveAccount(seed, 0, 1);

  const fundingScript = p2wpkhScript(hash160(key.publicKey));
  const utxoA = {
    txid: '75ddabb27b8845f5247975c8a5ba7c6f336c4570708ebe230caf6db5217ae858',
    vout: 0,
    value: 50_000n,
  };
  const utxoB = {
    txid: '1dea7cd05979072a3578cab271c02244ea8a090bbb46aa680a65ecd027048d83',
    vout: 1,
    value: 30_000n,
  };

  const tx: UnsignedTransaction = {
    version: 2,
    locktime: 0,
    inputs: [
      { ...utxoA, scriptPubKey: fundingScript },
      { ...utxoB, scriptPubKey: fundingScript },
    ],
    outputs: [
      { value: 60_000n, scriptPubKey: addressToScriptPubKey(recipient.address, BITCOIN) },
      { value: 15_000n, scriptPubKey: addressToScriptPubKey(account.address, BITCOIN) },
    ],
  };

  function buildWithBitcoinjs(): bitcoin.Transaction {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    psbt.setVersion(2);
    psbt.setLocktime(0);
    for (const utxo of [utxoA, utxoB]) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { script: Buffer.from(fundingScript), value: Number(utxo.value) },
      });
    }
    for (const output of tx.outputs) {
      psbt.addOutput({ script: Buffer.from(output.scriptPubKey), value: Number(output.value) });
    }
    psbt.signAllInputs(key.bjsSigner);
    psbt.finalizeAllInputs();
    return psbt.extractTransaction();
  }

  it('produces a byte-identical fully signed transaction', () => {
    // Sign with the core DerivedAccount itself: proves the wallet's real
    // key object plugs straight into the transaction builder.
    const signed = signTransaction(tx, account);
    const ourHex = bytesToHex(serializeTransaction(signed.tx, signed.signedInputs));
    const theirs = buildWithBitcoinjs();
    expect(ourHex).toBe(theirs.toHex());
  });

  it('agrees on the txid', () => {
    const signed = signTransaction(tx, account);
    expect(transactionId(signed.tx, signed.signedInputs)).toBe(buildWithBitcoinjs().getId());
  });

  it('matches the BIP-84 reference address for the test mnemonic', () => {
    // First receive address for this mnemonic per the BIP-84 test vectors.
    expect(account.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });
});

describe('legacy P2PKH (Dogecoin) vs bitcoinjs-lib', () => {
  // Dogecoin mainnet parameters, verified against dogecoin/dogecoin
  // src/chainparams.cpp: PUBKEY_ADDRESS = 30 (0x1e), SCRIPT_ADDRESS = 22
  // (0x16), SECRET_KEY (WIF) = 158 (0x9e). The bip32 constants are unused
  // by these tests (no xpub handling), so Bitcoin's are fine placeholders.
  const dogeNetwork: bitcoin.networks.Network = {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    bech32: '',
    bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    pubKeyHash: 0x1e,
    scriptHash: 0x16,
    wif: 0x9e,
  };

  const account = dogecoinKeyProvider.deriveAccount(seed, 0, 0);
  const key = keyAt(dogecoinKeyProvider.derivationPath(0, 0));
  const recipient = dogecoinKeyProvider.deriveAccount(seed, 0, 1);
  const fundingScript = addressToScriptPubKey(account.address, DOGECOIN);

  // Legacy PSBT inputs need the full funding transaction, so fabricate one
  // with our own serializer: a coinbase-style input paying the wallet twice.
  // bitcoinjs re-hashes these bytes to validate the outpoints, which
  // doubles as an independent check of our serializer and txid code.
  const fundingTx: UnsignedTransaction = {
    version: 1,
    locktime: 0,
    inputs: [
      {
        txid: '0000000000000000000000000000000000000000000000000000000000000000',
        vout: 0xffffffff,
        value: 0n,
        scriptPubKey: new Uint8Array(0),
      },
    ],
    outputs: [
      { value: 700_000_000n, scriptPubKey: fundingScript },
      { value: 300_000_000n, scriptPubKey: fundingScript },
    ],
  };
  const fundingBytes = serializeTransaction(fundingTx, undefined, false);
  const fundingTxid = transactionId(fundingTx);

  const tx: UnsignedTransaction = {
    version: 1, // Dogecoin nodes still produce version-1 transactions
    locktime: 0,
    inputs: [
      { txid: fundingTxid, vout: 0, value: 700_000_000n, scriptPubKey: fundingScript },
      { txid: fundingTxid, vout: 1, value: 300_000_000n, scriptPubKey: fundingScript },
    ],
    outputs: [
      { value: 650_000_000n, scriptPubKey: addressToScriptPubKey(recipient.address, DOGECOIN) },
      { value: 100_000_000n, scriptPubKey: fundingScript },
    ],
  };

  function buildWithBitcoinjs(): bitcoin.Transaction {
    const psbt = new bitcoin.Psbt({ network: dogeNetwork });
    psbt.setVersion(1);
    psbt.setLocktime(0);
    for (const input of tx.inputs) {
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        nonWitnessUtxo: Buffer.from(fundingBytes),
      });
    }
    for (const output of tx.outputs) {
      psbt.addOutput({ script: Buffer.from(output.scriptPubKey), value: Number(output.value) });
    }
    psbt.signAllInputs(key.bjsSigner);
    psbt.finalizeAllInputs();
    // true disables bitcoinjs's absolute-fee sanity warning: Dogecoin
    // amounts are ~100 million times Bitcoin's economics, so a normal
    // Dogecoin fee trips a check calibrated for BTC.
    return psbt.extractTransaction(true);
  }

  it('produces a byte-identical fully signed transaction', () => {
    const signed = signTransaction(tx, account);
    const ourHex = bytesToHex(serializeTransaction(signed.tx, signed.signedInputs));
    expect(ourHex).toBe(buildWithBitcoinjs().toHex());
  });

  it('agrees on the txid', () => {
    const signed = signTransaction(tx, account);
    expect(transactionId(signed.tx, signed.signedInputs)).toBe(buildWithBitcoinjs().getId());
  });

  it('bitcoinjs derives the same D... address from the same key', () => {
    const { address } = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(key.publicKey),
      network: dogeNetwork,
    });
    expect(address).toBe(account.address);
  });
});

describe('signing guardrails', () => {
  const account = bitcoinKeyProvider.deriveAccount(seed, 0, 0);
  const stranger = bitcoinKeyProvider.deriveAccount(seed, 0, 7);
  const script = addressToScriptPubKey(account.address, BITCOIN);

  const tx: UnsignedTransaction = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        txid: '75ddabb27b8845f5247975c8a5ba7c6f336c4570708ebe230caf6db5217ae858',
        vout: 0,
        value: 10_000n,
        scriptPubKey: script,
      },
    ],
    outputs: [{ value: 9_000n, scriptPubKey: script }],
  };

  it('refuses to sign with a key that does not own the input', () => {
    expect(() => signTransaction(tx, stranger)).toThrow(/does not match the P2WPKH program/);
  });

  it('refuses unsupported input script templates', () => {
    const weird = { ...tx, inputs: [{ ...tx.inputs[0]!, scriptPubKey: new Uint8Array([0x51]) }] };
    expect(() => signTransaction(weird, account)).toThrow(/unsupported scriptPubKey/);
  });
});

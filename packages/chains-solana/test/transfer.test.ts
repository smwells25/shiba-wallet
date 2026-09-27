import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import {
  mnemonicToSeed,
  slip10DerivePath,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { compileMessage, serializeMessage } from '../src/message.js';
import { SYSTEM_PROGRAM_ID, systemTransfer } from '../src/systemProgram.js';
import { signTransaction } from '../src/transaction.js';

/**
 * Cross-check against @solana/web3.js 1.x: the same transfer (same keys,
 * same blockhash, same lamports) built with the classic library and with
 * this package must produce identical message bytes and, because ed25519
 * signing is deterministic (RFC 8032), identical signatures too.
 */

// Standard BIP-39 test mnemonic; same one the core test suite uses.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(MNEMONIC);

// Sender is account 0, recipient is account 1, both on the Phantom-style
// path m/44'/501'/{account}'/0' that core's Solana provider uses.
const sender = solanaKeyProvider.deriveAccount(seed, 0, 0);
const recipient = solanaKeyProvider.deriveAccount(seed, 1, 0);

// A fixed, arbitrary 32-byte blockhash so the test is fully deterministic.
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(9));
const LAMPORTS = 1_234_567n;

/** Builds the reference transaction with @solana/web3.js. */
function buildWeb3Transaction(): Transaction {
  const tx = new Transaction({
    recentBlockhash: BLOCKHASH,
    feePayer: new PublicKey(sender.address),
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(sender.address),
      toPubkey: new PublicKey(recipient.address),
      lamports: Number(LAMPORTS),
    }),
  );
  return tx;
}

/** Builds the same message with this package. */
function buildOurMessage() {
  return compileMessage({
    feePayer: sender.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      systemTransfer({
        from: sender.publicKey,
        to: recipient.publicKey,
        lamports: LAMPORTS,
      }),
    ],
  });
}

describe('systemTransfer instruction encoding', () => {
  it('produces the documented 12-byte data: u32 LE index 2 + u64 LE lamports', () => {
    const ix = systemTransfer({
      from: sender.publicKey,
      to: recipient.publicKey,
      lamports: LAMPORTS,
    });
    expect(ix.data.length).toBe(12);
    // u32 LE 2
    expect([...ix.data.slice(0, 4)]).toEqual([2, 0, 0, 0]);
    // u64 LE 1_234_567 = 0x12D687
    expect([...ix.data.slice(4)]).toEqual([0x87, 0xd6, 0x12, 0, 0, 0, 0, 0]);
  });

  it('uses the all-zero System Program id', () => {
    expect(base58.encode(SYSTEM_PROGRAM_ID)).toBe('11111111111111111111111111111111');
    expect([...SYSTEM_PROGRAM_ID]).toEqual(new Array(32).fill(0));
  });
});

describe('cross-check against @solana/web3.js', () => {
  it('serializes the identical message bytes', () => {
    const theirs = new Uint8Array(buildWeb3Transaction().compileMessage().serialize());
    const ours = serializeMessage(buildOurMessage());
    expect([...ours]).toEqual([...theirs]);
  });

  it('produces the identical signature and full wire bytes', () => {
    // web3.js needs the raw 32-byte private key, which core's DerivedAccount
    // deliberately does not expose; re-derive it via core's SLIP-0010 path.
    const node = slip10DerivePath(seed, "m/44'/501'/0'/0'");
    const keypair = Keypair.fromSeed(node.privateKey);
    expect(keypair.publicKey.toBase58()).toBe(sender.address);

    const web3Tx = buildWeb3Transaction();
    web3Tx.sign(keypair);
    const theirWire = new Uint8Array(web3Tx.serialize());
    const theirSignature = new Uint8Array(web3Tx.signature!);

    const signed = signTransaction(buildOurMessage(), [sender]);

    // ed25519 (RFC 8032) is deterministic, so the signatures match exactly.
    expect([...signed.signatures[0]!]).toEqual([...theirSignature]);
    expect([...signed.wireBytes]).toEqual([...theirWire]);
    expect(signed.signature).toBe(base58.encode(theirSignature));
  });

  it('produces a signature that verifies against the sender key', () => {
    const signed = signTransaction(buildOurMessage(), [sender]);
    expect(
      ed25519.verify(signed.signatures[0]!, signed.messageBytes, sender.publicKey),
    ).toBe(true);
  });

  it('compiles the documented header and account ordering', () => {
    const message = buildOurMessage();
    // One writable signer (fee payer/sender), no readonly signers, and one
    // readonly non-signer (the System Program). Recipient is writable.
    expect(message.header).toEqual({
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1,
    });
    expect(message.accountKeys.map((k) => base58.encode(k))).toEqual([
      sender.address,
      recipient.address,
      '11111111111111111111111111111111',
    ]);
    expect(message.instructions).toEqual([
      { programIdIndex: 2, accountIndexes: [0, 1], data: expect.any(Uint8Array) },
    ]);
  });

  it('refuses to sign when a required signer is missing', () => {
    expect(() => signTransaction(buildOurMessage(), [])).toThrow(/missing signer/);
  });
});

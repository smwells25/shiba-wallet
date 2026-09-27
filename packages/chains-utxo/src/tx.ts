import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hash160 } from '@shiba-wallet/core';
import { isP2pkhScript, isP2wpkhScript, p2pkhScript } from './address.js';
import {
  bytesToHex,
  concatBytes,
  reverseBytes,
  txidToBytes,
  u32le,
  u64le,
  varInt,
} from './encoding.js';

/**
 * Raw transaction construction and signing for the UTXO family. Everything
 * in this file is pure and offline: bytes in, bytes out, no I/O. The wire
 * format is assembled by hand (that is serialization, not cryptography);
 * hashing and ECDSA come exclusively from @noble/hashes and @noble/curves.
 *
 * Two spend paths are supported, matching the wallet's key providers:
 * - Bitcoin native segwit P2WPKH, signed with the BIP-143 sighash;
 * - Dogecoin legacy P2PKH, signed with the original Bitcoin sighash
 *   algorithm (Dogecoin inherited it unchanged and has no segwit).
 */

/** SIGHASH_ALL: the signature commits to all inputs and all outputs. */
export const SIGHASH_ALL = 0x01;

/** Final sequence number; disables BIP-125 replace-by-fee signaling. */
export const SEQUENCE_FINAL = 0xffffffff;

export interface TransactionInput {
  /** Funding transaction id, big-endian hex as explorers display it. */
  txid: string;
  /** Output index inside the funding transaction. */
  vout: number;
  /** Value in satoshis of the output being spent. Required for BIP-143. */
  value: bigint;
  /** scriptPubKey of the output being spent; selects the signing scheme. */
  scriptPubKey: Uint8Array;
  /** Sequence number; defaults to SEQUENCE_FINAL. */
  sequence?: number;
}

export interface TransactionOutput {
  /** Value in satoshis. */
  value: bigint;
  scriptPubKey: Uint8Array;
}

export interface UnsignedTransaction {
  /** Transaction version. Bitcoin wallets use 2 (BIP-68); Dogecoin uses 1. */
  version: number;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  locktime: number;
}

/** The unlocking data produced by signing one input. */
export interface SignedInput {
  /** Legacy unlocking script; empty for native segwit inputs. */
  scriptSig: Uint8Array;
  /** Witness stack items; empty for legacy inputs. */
  witness: Uint8Array[];
}

export interface SignedTransaction {
  tx: UnsignedTransaction;
  signedInputs: SignedInput[];
}

/**
 * The signing half of an account, shaped exactly like core's DerivedAccount:
 * a compressed public key plus a sign() that returns the 64-byte compact
 * r||s signature over a 32-byte digest. Core signs with @noble/curves'
 * default lowS: true, and signTransaction() rejects any high-S signature it
 * is handed, so the consensus low-S rule holds regardless of the signer.
 */
export interface InputSigner {
  publicKey: Uint8Array;
  sign(digest: Uint8Array): Uint8Array;
}

/** double-SHA256, Bitcoin's workhorse hash for txids and sighashes. */
export function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** Little-endian outpoint: reversed txid followed by the 4-byte vout. */
function serializeOutpoint(input: TransactionInput): Uint8Array {
  return concatBytes(txidToBytes(input.txid), u32le(input.vout));
}

function serializeOutput(output: TransactionOutput): Uint8Array {
  return concatBytes(u64le(output.value), varInt(output.scriptPubKey.length), output.scriptPubKey);
}

/** A script prefixed with its CompactSize length, as the wire format wants. */
function lengthPrefixed(script: Uint8Array): Uint8Array {
  return concatBytes(varInt(script.length), script);
}

/** Minimal-push of a data item inside a script (all our items are < 76 bytes). */
function pushData(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length > 75) {
    throw new Error(`pushData supports 1-75 byte items, got ${data.length}`);
  }
  return concatBytes(new Uint8Array([data.length]), data);
}

/**
 * Serializes the transaction. Layout, in order:
 *   version (4 LE) | [marker 0x00, flag 0x01 if any witness] |
 *   input count | inputs (outpoint, scriptSig, sequence) |
 *   output count | outputs (value 8 LE, scriptPubKey) |
 *   [witness stacks, one per input] | locktime (4 LE)
 *
 * With no signedInputs it produces the unsigned skeleton (empty scriptSigs).
 * `includeWitness: false` gives the legacy serialization used for txids.
 */
export function serializeTransaction(
  tx: UnsignedTransaction,
  signedInputs?: SignedInput[],
  includeWitness = true,
): Uint8Array {
  if (signedInputs && signedInputs.length !== tx.inputs.length) {
    throw new Error('signedInputs length must match inputs length');
  }
  const hasWitness =
    includeWitness && !!signedInputs && signedInputs.some((s) => s.witness.length > 0);

  const parts: Uint8Array[] = [u32le(tx.version)];
  // Segwit marker (0x00) and flag (0x01) per BIP-144. The zero marker is
  // unparseable as an input count, which is how old software rejects it.
  if (hasWitness) parts.push(new Uint8Array([0x00, 0x01]));

  parts.push(varInt(tx.inputs.length));
  tx.inputs.forEach((input, i) => {
    parts.push(
      serializeOutpoint(input),
      lengthPrefixed(signedInputs ? signedInputs[i]!.scriptSig : new Uint8Array(0)),
      u32le(input.sequence ?? SEQUENCE_FINAL),
    );
  });

  parts.push(varInt(tx.outputs.length));
  for (const output of tx.outputs) parts.push(serializeOutput(output));

  if (hasWitness) {
    // One stack per input, even for legacy inputs (their stack is empty).
    for (const signed of signedInputs) {
      parts.push(varInt(signed.witness.length));
      for (const item of signed.witness) parts.push(lengthPrefixed(item));
    }
  }

  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}

/**
 * Transaction id: double-SHA256 of the legacy (witness-stripped)
 * serialization, displayed byte-reversed. Witness data is deliberately
 * excluded so segwit txids are non-malleable.
 */
export function transactionId(tx: UnsignedTransaction, signedInputs?: SignedInput[]): string {
  return bytesToHex(reverseBytes(dsha256(serializeTransaction(tx, signedInputs, false))));
}

/**
 * Original Bitcoin sighash (pre-segwit), used for Dogecoin P2PKH spends.
 * The transaction is re-serialized with every scriptSig blanked except the
 * input being signed, which carries the scriptCode (for P2PKH, the previous
 * output's scriptPubKey). The 4-byte sighash type is appended before the
 * double-SHA256. SIGHASH_ALL only; other types are out of scope here.
 */
export function legacySighash(
  tx: UnsignedTransaction,
  inputIndex: number,
  scriptCode: Uint8Array,
  sighashType = SIGHASH_ALL,
): Uint8Array {
  const parts: Uint8Array[] = [u32le(tx.version), varInt(tx.inputs.length)];
  tx.inputs.forEach((input, i) => {
    parts.push(
      serializeOutpoint(input),
      lengthPrefixed(i === inputIndex ? scriptCode : new Uint8Array(0)),
      u32le(input.sequence ?? SEQUENCE_FINAL),
    );
  });
  parts.push(varInt(tx.outputs.length));
  for (const output of tx.outputs) parts.push(serializeOutput(output));
  parts.push(u32le(tx.locktime), u32le(sighashType));
  return dsha256(concatBytes(...parts));
}

/**
 * BIP-143 sighash for segwit v0 inputs (P2WPKH here). Unlike the legacy
 * algorithm it commits to the spent output's value and hashes the prevouts,
 * sequences, and outputs once each, so signing cost is linear. Preimage
 * layout follows the BIP-143 specification exactly:
 *   version | hashPrevouts | hashSequence | outpoint | scriptCode |
 *   value | sequence | hashOutputs | locktime | sighash type
 */
export function segwitV0Sighash(
  tx: UnsignedTransaction,
  inputIndex: number,
  scriptCode: Uint8Array,
  sighashType = SIGHASH_ALL,
): Uint8Array {
  const input = tx.inputs[inputIndex];
  if (!input) throw new Error(`No input at index ${inputIndex}`);

  // With SIGHASH_ALL (no ANYONECANPAY), all three intermediate hashes are
  // the "commit to everything" variants from the BIP.
  const hashPrevouts = dsha256(concatBytes(...tx.inputs.map(serializeOutpoint)));
  const hashSequence = dsha256(
    concatBytes(...tx.inputs.map((i) => u32le(i.sequence ?? SEQUENCE_FINAL))),
  );
  const hashOutputs = dsha256(concatBytes(...tx.outputs.map(serializeOutput)));

  return dsha256(
    concatBytes(
      u32le(tx.version),
      hashPrevouts,
      hashSequence,
      serializeOutpoint(input),
      lengthPrefixed(scriptCode),
      u64le(input.value),
      u32le(input.sequence ?? SEQUENCE_FINAL),
      hashOutputs,
      u32le(tx.locktime),
      u32le(sighashType),
    ),
  );
}

/**
 * Converts a 64-byte compact (r || s) signature into DER and appends the
 * sighash-type byte, producing the exact blob scripts expect. DER encoding
 * is delegated to @noble/curves' Signature codec — verified against the
 * installed @noble/curves 2.4.0 typings (ECDSASignatureFormat includes
 * 'der'). High-S signatures are rejected: Bitcoin's standardness rules
 * (BIP-62 low-S) forbid them, and every @noble signer produces low-S by
 * default, so a high-S value here means a misbehaving signer.
 */
export function encodeDerSignature(compactSig: Uint8Array, sighashType = SIGHASH_ALL): Uint8Array {
  const sig = secp256k1.Signature.fromBytes(compactSig, 'compact');
  if (sig.hasHighS()) {
    throw new Error('Signer produced a high-S signature; low-S is required (BIP-62)');
  }
  return concatBytes(sig.toBytes('der'), new Uint8Array([sighashType]));
}

/**
 * Signs every input of the transaction with SIGHASH_ALL. The signing scheme
 * for each input is chosen from the spent output's scriptPubKey:
 * - P2WPKH: BIP-143 digest; witness = [signature, pubkey]; empty scriptSig.
 * - P2PKH: legacy digest; scriptSig = <signature> <pubkey>; empty witness.
 * Any other script template is rejected.
 *
 * `signers` is either one signer for all inputs (the common single-address
 * wallet case) or one per input. Each signer's public key is checked against
 * the spent script's pubkey hash before signing, so signing with the wrong
 * key fails loudly instead of producing an unspendable transaction.
 */
export function signTransaction(
  tx: UnsignedTransaction,
  signers: InputSigner | InputSigner[],
): SignedTransaction {
  const perInput = Array.isArray(signers) ? signers : tx.inputs.map(() => signers);
  if (perInput.length !== tx.inputs.length) {
    throw new Error(`Need ${tx.inputs.length} signers, got ${perInput.length}`);
  }

  const signedInputs = tx.inputs.map((input, i) => {
    const signer = perInput[i]!;
    const pubKeyHash = hash160(signer.publicKey);

    if (isP2wpkhScript(input.scriptPubKey)) {
      const program = input.scriptPubKey.subarray(2);
      if (bytesToHex(program) !== bytesToHex(pubKeyHash)) {
        throw new Error(`Input ${i}: signer's key does not match the P2WPKH program`);
      }
      // BIP-143: for P2WPKH the scriptCode is the canonical P2PKH script
      // over the same 20-byte hash, not the witness program itself.
      const scriptCode = p2pkhScript(program);
      const digest = segwitV0Sighash(tx, i, scriptCode, SIGHASH_ALL);
      const signature = encodeDerSignature(signer.sign(digest), SIGHASH_ALL);
      return { scriptSig: new Uint8Array(0), witness: [signature, signer.publicKey] };
    }

    if (isP2pkhScript(input.scriptPubKey)) {
      const expectedHash = input.scriptPubKey.subarray(3, 23);
      if (bytesToHex(expectedHash) !== bytesToHex(pubKeyHash)) {
        throw new Error(`Input ${i}: signer's key does not match the P2PKH hash`);
      }
      const digest = legacySighash(tx, i, input.scriptPubKey, SIGHASH_ALL);
      const signature = encodeDerSignature(signer.sign(digest), SIGHASH_ALL);
      const scriptSig = concatBytes(pushData(signature), pushData(signer.publicKey));
      return { scriptSig, witness: [] as Uint8Array[] };
    }

    throw new Error(
      `Input ${i}: unsupported scriptPubKey template (only P2WPKH and P2PKH spends are implemented)`,
    );
  });

  return { tx, signedInputs };
}

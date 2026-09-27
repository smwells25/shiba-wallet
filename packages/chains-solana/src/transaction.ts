import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { bytesEqual, concatBytes, encodeShortU16 } from './encoding.js';
import { serializeMessage, type CompiledMessage } from './message.js';

/**
 * Transaction signing and wire serialization. Pure and offline; the RPC
 * client in rpc.ts takes the produced base64 string for sendTransaction.
 *
 * Wire format, per https://solana.com/docs/core/transactions/transaction-structure
 * (fetched 2026-09-27): a compact-u16 signature count, then that many
 * 64-byte ed25519 signatures, then the serialized message. Each signature
 * is "a 64-byte Ed25519 signature of the serialized Message" and the
 * signature order must match the order of the first
 * num_required_signatures account keys in the message.
 */

/**
 * Anything that can sign for one account. Structurally compatible with
 * @shiba-wallet/core's DerivedAccount, so a derived account can be passed
 * straight in, but the message layer does not depend on core's types.
 */
export interface TransactionSigner {
  /** 32-byte ed25519 public key. */
  publicKey: Uint8Array;
  /** Returns the 64-byte ed25519 signature over the given message bytes. */
  sign(message: Uint8Array): Uint8Array;
}

export interface SignedTransaction {
  /** The exact message bytes that were signed. */
  messageBytes: Uint8Array;
  /** 64-byte signatures, ordered to match the message's signer keys. */
  signatures: Uint8Array[];
  /** Full wire bytes: shortvec(signature count) + signatures + message. */
  wireBytes: Uint8Array;
  /** Base64 of wireBytes, ready for sendTransaction with encoding base64. */
  base64: string;
  /**
   * Base58 of the first (fee payer) signature. Solana uses this as the
   * transaction id, and sendTransaction returns the same string.
   */
  signature: string;
}

/**
 * Signs a compiled message with every required signer and assembles the
 * final wire-format transaction.
 *
 * Signers may be passed in any order; they are matched to the message's
 * required-signer keys by public key. Missing signers are an error, and
 * every produced signature is verified against the message before the
 * transaction is returned, so a corrupted or mismatched key fails loudly
 * here instead of on-chain.
 */
export function signTransaction(
  message: CompiledMessage,
  signers: TransactionSigner[],
): SignedTransaction {
  const messageBytes = serializeMessage(message);
  const required = message.header.numRequiredSignatures;
  const signerKeys = message.accountKeys.slice(0, required);

  const signatures: Uint8Array[] = signerKeys.map((key) => {
    const signer = signers.find((s) => bytesEqual(s.publicKey, key));
    if (!signer) {
      throw new Error(`missing signer for account ${base58.encode(key)}`);
    }
    const signature = signer.sign(messageBytes);
    if (signature.length !== 64) {
      throw new Error('ed25519 signatures must be 64 bytes');
    }
    // Sanity check: reject a signature that does not verify against the
    // claimed public key rather than broadcasting a doomed transaction.
    if (!ed25519.verify(signature, messageBytes, key)) {
      throw new Error(`signature for ${base58.encode(key)} failed verification`);
    }
    return signature;
  });

  const wireBytes = concatBytes(
    encodeShortU16(signatures.length),
    ...signatures,
    messageBytes,
  );

  const firstSignature = signatures[0];
  if (!firstSignature) {
    throw new Error('a transaction needs at least one signature');
  }

  return {
    messageBytes,
    signatures,
    wireBytes,
    base64: base64.encode(wireBytes),
    signature: base58.encode(firstSignature),
  };
}

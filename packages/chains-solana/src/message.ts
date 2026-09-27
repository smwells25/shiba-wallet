import { base58 } from '@scure/base';
import { bytesEqual, concatBytes, encodeShortU16 } from './encoding.js';

/**
 * Legacy Solana message construction. Pure and offline: nothing here touches
 * the network. The binary layout implemented below is taken from the
 * official reference, https://solana.com/docs/core/transactions/transaction-structure
 * (fetched 2026-09-27):
 *
 *   message header (3 bytes, one u8 each):
 *     1. num_required_signatures  - "The number of signatures required for
 *        this message to be considered valid"
 *     2. num_readonly_signed_accounts  - "The last num_readonly_signed_accounts
 *        of the signed keys are read-only accounts"
 *     3. num_readonly_unsigned_accounts - "The last num_readonly_unsigned_accounts
 *        of the unsigned keys are read-only accounts"
 *   account addresses: compact-u16 count, then 32-byte public keys ordered
 *     "Signer + Writable, Signer + Read-only, Non-signer + Writable,
 *     Non-signer + Read-only", with the fee payer required to be "the first
 *     account in the message (index 0) and a signer"
 *   recent blockhash: 32 bytes
 *   instructions: compact-u16 count, then per instruction a u8
 *     program_id_index, a compact-u16-prefixed array of u8 account indices,
 *     and a compact-u16-prefixed data byte array.
 */

/** One account an instruction touches, with its access flags. */
export interface AccountMeta {
  /** 32-byte ed25519 public key. */
  pubkey: Uint8Array;
  /** True when the account must sign the transaction. */
  isSigner: boolean;
  /** True when the instruction may modify the account (including lamports). */
  isWritable: boolean;
}

/** A single instruction before compilation into message indices. */
export interface SolanaInstruction {
  /** 32-byte public key of the program that executes this instruction. */
  programId: Uint8Array;
  /** Accounts the instruction reads or writes, in program-defined order. */
  keys: AccountMeta[];
  /** Program-specific input data. */
  data: Uint8Array;
}

/** An instruction compiled to indices into the message's account key list. */
export interface CompiledInstruction {
  programIdIndex: number;
  /** Indices into the static account key array, in instruction order. */
  accountIndexes: number[];
  data: Uint8Array;
}

/** A fully compiled legacy message, ready to serialize and sign. */
export interface CompiledMessage {
  header: {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
  };
  /** Static account keys, 32 bytes each, in signing/privilege order. */
  accountKeys: Uint8Array[];
  /** Base58-encoded 32-byte recent blockhash. */
  recentBlockhash: string;
  instructions: CompiledInstruction[];
}

export interface CompileMessageParams {
  /** Fee payer public key. Always becomes account index 0 and a signer. */
  feePayer: Uint8Array;
  /** Base58-encoded recent blockhash from getLatestBlockhash. */
  recentBlockhash: string;
  instructions: SolanaInstruction[];
}

/**
 * Compiles instructions into a legacy message: collects every referenced
 * account, merges duplicate references (an account is a signer or writable
 * if ANY reference says so), orders them per the documented privilege
 * ordering, and rewrites instructions as indices into that ordered list.
 *
 * Within each privilege class, keys are sorted by their base58 string using
 * plain code-point comparison so compilation is deterministic. Note that
 * @solana/web3.js 1.x sorts within a class using localeCompare with the
 * "en" locale, which can differ from code-point order when a class contains
 * several keys whose base58 forms differ only by letter case. For messages
 * with at most one key per class (such as a single System transfer) the two
 * orderings are provably identical, and the cross-check test asserts
 * byte-for-byte equality against web3.js.
 */
export function compileMessage(params: CompileMessageParams): CompiledMessage {
  const { feePayer, recentBlockhash, instructions } = params;
  if (feePayer.length !== 32) {
    throw new Error('fee payer must be a 32-byte public key');
  }
  if (instructions.length === 0) {
    throw new Error('a message needs at least one instruction');
  }
  // Validate the blockhash decodes to exactly 32 bytes before going further.
  const blockhashBytes = base58.decode(recentBlockhash);
  if (blockhashBytes.length !== 32) {
    throw new Error('recentBlockhash must decode to 32 bytes');
  }

  // Gather every account reference. Program ids participate in the account
  // list too, as readonly non-signers (they are executable accounts).
  const merged: AccountMeta[] = [];
  const addMeta = (meta: AccountMeta): void => {
    const existing = merged.find((m) => bytesEqual(m.pubkey, meta.pubkey));
    if (existing) {
      // Privileges are the union of every reference to the same key.
      existing.isSigner ||= meta.isSigner;
      existing.isWritable ||= meta.isWritable;
    } else {
      merged.push({ pubkey: meta.pubkey, isSigner: meta.isSigner, isWritable: meta.isWritable });
    }
  };
  for (const ix of instructions) {
    if (ix.programId.length !== 32) {
      throw new Error('program id must be a 32-byte public key');
    }
    for (const key of ix.keys) {
      if (key.pubkey.length !== 32) {
        throw new Error('account key must be a 32-byte public key');
      }
      addMeta(key);
    }
    addMeta({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  // The fee payer is always a writable signer, whatever the instructions say.
  addMeta({ pubkey: feePayer, isSigner: true, isWritable: true });
  const payer = merged.find((m) => bytesEqual(m.pubkey, feePayer))!;
  payer.isSigner = true;
  payer.isWritable = true;

  // Order: fee payer, writable signers, readonly signers, writable
  // non-signers, readonly non-signers. Sorting within a class keeps the
  // output deterministic regardless of instruction key order.
  const classOf = (m: AccountMeta): number => {
    if (bytesEqual(m.pubkey, feePayer)) return 0;
    if (m.isSigner && m.isWritable) return 1;
    if (m.isSigner) return 2;
    if (m.isWritable) return 3;
    return 4;
  };
  merged.sort((a, b) => {
    const ca = classOf(a);
    const cb = classOf(b);
    if (ca !== cb) return ca - cb;
    const sa = base58.encode(a.pubkey);
    const sb = base58.encode(b.pubkey);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  // Header counts follow directly from the ordered privilege classes.
  const numRequiredSignatures = merged.filter((m) => m.isSigner).length;
  const numReadonlySignedAccounts = merged.filter((m) => m.isSigner && !m.isWritable).length;
  const numReadonlyUnsignedAccounts = merged.filter((m) => !m.isSigner && !m.isWritable).length;

  const accountKeys = merged.map((m) => m.pubkey);
  const indexOfKey = (pubkey: Uint8Array): number => {
    const index = accountKeys.findIndex((k) => bytesEqual(k, pubkey));
    if (index < 0) throw new Error('internal error: key missing from compiled list');
    return index;
  };

  const compiled: CompiledInstruction[] = instructions.map((ix) => ({
    programIdIndex: indexOfKey(ix.programId),
    accountIndexes: ix.keys.map((k) => indexOfKey(k.pubkey)),
    data: ix.data,
  }));

  return {
    header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
    accountKeys,
    recentBlockhash,
    instructions: compiled,
  };
}

/**
 * Serializes a compiled message to the exact bytes that get signed. Layout
 * cited at the top of this file.
 */
export function serializeMessage(message: CompiledMessage): Uint8Array {
  const parts: Uint8Array[] = [];

  // Header: three raw u8 values, in documented order.
  parts.push(
    Uint8Array.from([
      message.header.numRequiredSignatures,
      message.header.numReadonlySignedAccounts,
      message.header.numReadonlyUnsignedAccounts,
    ]),
  );

  // Static account keys: compact-u16 count, then each 32-byte key.
  parts.push(encodeShortU16(message.accountKeys.length));
  for (const key of message.accountKeys) {
    parts.push(key);
  }

  // Recent blockhash: 32 raw bytes (the base58 form is only transport sugar).
  const blockhash = base58.decode(message.recentBlockhash);
  if (blockhash.length !== 32) {
    throw new Error('recentBlockhash must decode to 32 bytes');
  }
  parts.push(blockhash);

  // Instructions: compact-u16 count, then each compiled instruction as
  // program id index (u8), compact account-index array, compact data array.
  parts.push(encodeShortU16(message.instructions.length));
  for (const ix of message.instructions) {
    parts.push(Uint8Array.from([ix.programIdIndex]));
    parts.push(encodeShortU16(ix.accountIndexes.length));
    parts.push(Uint8Array.from(ix.accountIndexes));
    parts.push(encodeShortU16(ix.data.length));
    parts.push(ix.data);
  }

  return concatBytes(...parts);
}

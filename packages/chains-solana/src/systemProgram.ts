import { base58 } from '@scure/base';
import { concatBytes, u32ToLeBytes, u64ToLeBytes } from './encoding.js';
import type { SolanaInstruction } from './message.js';

/**
 * System Program instructions: Transfer and CreateAccount. Other variants
 * can be added the same way without touching the message layer.
 */

/**
 * The System Program's well-known address. Base58
 * "11111111111111111111111111111111" decodes to 32 zero bytes.
 */
export const SYSTEM_PROGRAM_ID: Uint8Array = base58.decode(
  '11111111111111111111111111111111',
);

/**
 * Builds a System Program transfer instruction (move lamports between two
 * system-owned accounts).
 *
 * Instruction data encoding, verified against two sources on 2026-09-27:
 *
 * 1. The Rust interface crate. docs.rs for solana-system-interface
 *    (solana_system_interface::instruction::SystemInstruction) lists the
 *    enum variants in order CreateAccount = 0, Assign = 1, Transfer = 2,
 *    with Transfer carrying a single `lamports: u64` field. The on-chain
 *    program deserializes this enum with bincode, which encodes the variant
 *    tag as a u32 and integers little-endian.
 *
 * 2. The installed @solana/web3.js 1.99.0 reference implementation
 *    (node_modules/@solana/web3.js/lib/index.cjs.js, SYSTEM_INSTRUCTION_LAYOUTS):
 *    `Transfer: { index: 2, layout: struct([u32('instruction'), u64('lamports')]) }`,
 *    where @solana/buffer-layout u32/u64 write little-endian.
 *
 * So the data is exactly 12 bytes: u32 little-endian value 2, then the
 * lamport amount as a u64 little-endian. The cross-check test in this
 * package additionally asserts byte equality against web3.js output.
 *
 * Account order (same web3.js layout source): [from, to], both writable,
 * with only `from` signing.
 */
export function systemTransfer(params: {
  /** 32-byte public key of the funding account; must sign. */
  from: Uint8Array;
  /** 32-byte public key of the recipient account. */
  to: Uint8Array;
  /** Amount in lamports (1 SOL = 1_000_000_000 lamports). */
  lamports: bigint;
}): SolanaInstruction {
  const { from, to, lamports } = params;
  if (lamports < 0n) {
    throw new Error('lamports must be non-negative');
  }
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    // u32 LE instruction index (Transfer = 2) followed by u64 LE lamports.
    data: concatBytes(u32ToLeBytes(2), u64ToLeBytes(lamports)),
  };
}

/**
 * Builds a System Program CreateAccount instruction: a new account owned by
 * `owner`, with `space` bytes of data and `lamports` moved from `from`.
 *
 * Encoding, from the same two sources as systemTransfer: CreateAccount is
 * variant 0 of SystemInstruction, carrying `lamports: u64, space: u64,
 * owner: Pubkey` (bincode: a u32 tag, then little-endian integers, then the
 * 32 key bytes); the installed @solana/web3.js layout agrees
 * (`Create: { index: 0, layout: struct([u32('instruction'),
 * ns64('lamports'), ns64('space'), publicKey('programId')]) }`). 52 bytes
 * in all. Accounts: [from, newAccount], both writable and both signing.
 *
 * Used only by the test-network scripts that create a lab token mint; the
 * wallet itself never creates accounts this way.
 */
export function systemCreateAccount(params: {
  /** 32-byte public key of the funding account; must sign. */
  from: Uint8Array;
  /** 32-byte public key of the account to create; must sign. */
  newAccount: Uint8Array;
  lamports: bigint;
  /** Data length in bytes. */
  space: bigint;
  /** 32-byte id of the program that will own the account. */
  owner: Uint8Array;
}): SolanaInstruction {
  const { from, newAccount, lamports, space, owner } = params;
  if (lamports < 0n || space < 0n) throw new Error('lamports and space must be non-negative');
  if (owner.length !== 32) throw new Error('the owner program id must be 32 bytes');
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: newAccount, isSigner: true, isWritable: true },
    ],
    data: concatBytes(u32ToLeBytes(0), u64ToLeBytes(lamports), u64ToLeBytes(space), owner),
  };
}

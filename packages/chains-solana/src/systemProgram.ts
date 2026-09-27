import { base58 } from '@scure/base';
import { concatBytes, u32ToLeBytes, u64ToLeBytes } from './encoding.js';
import type { SolanaInstruction } from './message.js';

/**
 * System Program instructions. Only Transfer is implemented for now; other
 * variants can be added the same way without touching the message layer.
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

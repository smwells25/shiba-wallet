import { base58 } from '@scure/base';
import { concatBytes, u64ToLeBytes } from './encoding.js';
import type { SolanaInstruction } from './message.js';
import { findProgramAddress } from './pda.js';
import { SYSTEM_PROGRAM_ID } from './systemProgram.js';

/**
 * SPL Token transfers and Associated Token Account (ATA) handling. Pure and
 * offline: everything here just builds instructions for the existing message
 * compiler. Every constant and layout below was verified on 2026-09-27
 * against the official program sources named at its definition, and the
 * cross-check tests assert byte equality against @solana/spl-token 0.4.15.
 */

/**
 * The SPL Token program id. Verified against the official interface crate
 * in solana-program/associated-token-account (interface/src/address.rs,
 * inline_spl_token module), which declares
 * "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; the installed
 * @solana/spl-token 0.4.15 exports the same value as TOKEN_PROGRAM_ID.
 */
export const TOKEN_PROGRAM_ID: Uint8Array = base58.decode(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/**
 * The Associated Token Account program id. Verified against
 * solana-program/associated-token-account interface/src/lib.rs, whose
 * declare_id! reads "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".
 */
export const ASSOCIATED_TOKEN_PROGRAM_ID: Uint8Array = base58.decode(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/**
 * Derives the associated token account address for a wallet and mint.
 *
 * Seed order verified against solana-program/associated-token-account
 * interface/src/address.rs (fetched 2026-09-27), which passes exactly
 * [wallet_address, token_program_id, token_mint_address] to
 * find_program_address under the ATA program id.
 *
 * Works for any owner, including off-curve owners such as PDAs (a program
 * can own token accounts too); token programs other than the classic SPL
 * Token program (e.g. Token-2022) can be passed via tokenProgramId.
 */
export function findAssociatedTokenAddress(params: {
  /** 32-byte wallet address that owns the ATA. */
  owner: Uint8Array;
  /** 32-byte mint address of the token. */
  mint: Uint8Array;
  /** Token program owning the accounts; defaults to classic SPL Token. */
  tokenProgramId?: Uint8Array;
}): { address: Uint8Array; bump: number } {
  const { owner, mint, tokenProgramId = TOKEN_PROGRAM_ID } = params;
  if (owner.length !== 32 || mint.length !== 32) {
    throw new Error('owner and mint must be 32-byte public keys');
  }
  return findProgramAddress(
    [owner, tokenProgramId, mint],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Builds an SPL Token TransferChecked instruction.
 *
 * Preferred over plain Transfer because the program re-validates the mint
 * and the decimals against the actual accounts, so a wrong-mint or
 * wrong-decimals transfer fails on-chain instead of moving the wrong asset.
 *
 * Layout verified against solana-program/token interface/src/instruction.rs
 * (fetched 2026-09-27): TokenInstruction::TransferChecked is discriminant
 * 12 with fields { amount: u64, decimals: u8 }, packed as the tag byte
 * followed by the amount as 8 little-endian bytes and the decimals byte
 * (10 bytes total). Documented account order, same source:
 *
 *   0. `[writable]` The source account.
 *   1. `[]` The token mint.
 *   2. `[writable]` The destination account.
 *   3. `[signer]` The source account's owner/delegate.
 *
 * (The multisig-owner form with additional signer accounts is not needed by
 * the wallet and is not implemented.)
 */
export function splTransferChecked(params: {
  /** 32-byte address of the source token account (usually the owner's ATA). */
  source: Uint8Array;
  /** 32-byte mint address; the program checks it matches both accounts. */
  mint: Uint8Array;
  /** 32-byte address of the destination token account. */
  destination: Uint8Array;
  /** 32-byte wallet address owning (or delegated for) the source; signs. */
  owner: Uint8Array;
  /** Amount in the token's base units (u64). */
  amount: bigint;
  /** The mint's decimals; the program rejects a mismatch. */
  decimals: number;
  /** Token program owning the accounts; defaults to classic SPL Token. */
  tokenProgramId?: Uint8Array;
}): SolanaInstruction {
  const {
    source,
    mint,
    destination,
    owner,
    amount,
    decimals,
    tokenProgramId = TOKEN_PROGRAM_ID,
  } = params;
  if (amount < 0n) {
    throw new Error('amount must be non-negative');
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('decimals must be an integer in 0..255');
  }
  return {
    programId: tokenProgramId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    // Tag byte 12, u64 LE amount, u8 decimals.
    data: concatBytes(Uint8Array.of(12), u64ToLeBytes(amount), Uint8Array.of(decimals)),
  };
}

/**
 * Builds a Create Associated Token Account instruction, idempotent variant:
 * it succeeds as a no-op when the ATA already exists, so it can always be
 * prepended to a transfer without first querying the chain.
 *
 * Verified against solana-program/associated-token-account
 * interface/src/instruction.rs (fetched 2026-09-27):
 * AssociatedTokenAccountInstruction::CreateIdempotent is discriminant 1 and
 * the data is that single byte (`vec![instruction]`). Documented account
 * order, same source:
 *
 *   0. `[writeable,signer]` Funding account (must be a system account)
 *   1. `[writeable]` Associated token account address to be created
 *   2. `[]` Wallet address for the new associated token account
 *   3. `[]` The token mint for the new associated token account
 *   4. `[]` System program
 *   5. `[]` SPL Token program
 */
export function createAssociatedTokenAccountIdempotent(params: {
  /** 32-byte address paying rent for the new account; must sign. */
  payer: Uint8Array;
  /** 32-byte wallet address the ATA will belong to. */
  owner: Uint8Array;
  /** 32-byte mint address. */
  mint: Uint8Array;
  /** Token program owning the new account; defaults to classic SPL Token. */
  tokenProgramId?: Uint8Array;
}): SolanaInstruction {
  const { payer, owner, mint, tokenProgramId = TOKEN_PROGRAM_ID } = params;
  const ata = findAssociatedTokenAddress({ owner, mint, tokenProgramId });
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata.address, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

export interface SplTransferParams {
  /** 32-byte wallet address sending the tokens; signs the transfer. */
  owner: Uint8Array;
  /** 32-byte wallet address receiving the tokens (NOT a token account). */
  recipient: Uint8Array;
  /** 32-byte mint address of the token being sent. */
  mint: Uint8Array;
  /** Amount in the token's base units. */
  amount: bigint;
  /** The mint's decimals (e.g. 6 for USDC). */
  decimals: number;
  /**
   * When true, prepend an idempotent create-ATA instruction so a transfer
   * to a wallet that has never held this token creates the account in the
   * same transaction. The owner pays the rent. Safe to leave on: the
   * instruction is a no-op when the ATA already exists.
   */
  createRecipientAta?: boolean;
  /** Token program owning the accounts; defaults to classic SPL Token. */
  tokenProgramId?: Uint8Array;
}

export interface SplTransferPlan {
  /** Instructions in execution order, ready for compileMessage. */
  instructions: SolanaInstruction[];
  /** The sender's associated token account (transfer source). */
  sourceAta: Uint8Array;
  /** The recipient's associated token account (transfer destination). */
  destinationAta: Uint8Array;
}

/**
 * Composes the instructions for a wallet-to-wallet SPL token transfer:
 * derives both associated token accounts, optionally prepends the
 * idempotent create-ATA instruction for the recipient, and follows with a
 * TransferChecked. Feed the result to compileMessage with the owner as fee
 * payer, then signTransaction with the owner's key.
 */
export function buildSplTransfer(params: SplTransferParams): SplTransferPlan {
  const {
    owner,
    recipient,
    mint,
    amount,
    decimals,
    createRecipientAta = false,
    tokenProgramId = TOKEN_PROGRAM_ID,
  } = params;

  const sourceAta = findAssociatedTokenAddress({ owner, mint, tokenProgramId });
  const destinationAta = findAssociatedTokenAddress({
    owner: recipient,
    mint,
    tokenProgramId,
  });

  const instructions: SolanaInstruction[] = [];
  if (createRecipientAta) {
    instructions.push(
      createAssociatedTokenAccountIdempotent({
        payer: owner,
        owner: recipient,
        mint,
        tokenProgramId,
      }),
    );
  }
  instructions.push(
    splTransferChecked({
      source: sourceAta.address,
      mint,
      destination: destinationAta.address,
      owner,
      amount,
      decimals,
      tokenProgramId,
    }),
  );

  return {
    instructions,
    sourceAta: sourceAta.address,
    destinationAta: destinationAta.address,
  };
}

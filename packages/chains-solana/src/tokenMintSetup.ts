import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, u32ToLeBytes, u64ToLeBytes } from './encoding.js';
import type { SolanaInstruction } from './message.js';
import {
  EXT,
  MAX_FEE_BASIS_POINTS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ACCOUNT_BASE_LENGTH,
} from './tokenExtensions.js';

/**
 * Token-2022 instructions for CREATING a lab mint on a test network: the
 * transfer-fee and metadata-pointer extensions, InitializeMint2, the
 * TokenMetadata initialization and MintToChecked. The wallet itself never
 * creates or mints tokens; scripts/testnet/spl-fee-mint-smoke.mjs uses these
 * to make a devnet token with a transfer fee so that the wallet's
 * TransferCheckedWithFee path can be exercised live.
 *
 * Sources, read on 2026-11-09:
 *
 * - solana-program/token-2022 at commit 5170695d8c3958456dde0c4196c55aad362331e5:
 *   interface/src/instruction.rs (pack, lines 801-1000; pack_pubkey_option,
 *   lines 1179-1187; encode_instruction, lines 2159-2173),
 *   interface/src/extension/transfer_fee/instruction.rs (pack, lines
 *   206-245), interface/src/extension/metadata_pointer/instruction.rs
 *   (Initialize and InitializeInstructionData).
 * - solana-program/token-metadata at commit
 *   c1fe5e81cdb55648cd2013652a1a63cd4ec77357: interface/src/instruction.rs
 *   (Initialize, lines 20-32 and 88-104) and interface/src/state.rs
 *   (TokenMetadata, lines 28-43).
 *
 * Every encoder is pinned byte for byte in test/token2022.test.ts against
 * the installed @solana/spl-token 0.4.15 and @solana/spl-token-metadata 0.1.6.
 */

function u16ToLeBytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('a u16 must be in 0..65535');
  return Uint8Array.of(value & 0xff, value >> 8);
}

function checkKey(key: Uint8Array, what: string): void {
  if (key.length !== 32) throw new Error(`${what} must be 32 bytes`);
}

/**
 * COption<Pubkey> in a token instruction (pack_pubkey_option): Some is the
 * byte 1 and 32 key bytes, None is the single byte 0.
 */
function packPubkeyOption(key: Uint8Array | null): Uint8Array {
  if (key === null) return Uint8Array.of(0);
  checkKey(key, 'an optional key');
  return concatBytes(Uint8Array.of(1), key);
}

/** MaybeNull<Address> (OptionalNonZeroPubkey): 32 bytes, all zeros for none. */
function maybeNullKey(key: Uint8Array | null): Uint8Array {
  if (key === null) return new Uint8Array(32);
  checkKey(key, 'a key');
  if (key.every((b) => b === 0)) throw new Error('the all-zero key means "none"; pass null instead');
  return key;
}

function writableMint(mint: Uint8Array): SolanaInstruction['keys'] {
  checkKey(mint, 'the mint');
  return [{ pubkey: mint, isSigner: false, isWritable: true }];
}

/**
 * TransferFeeExtension (26) / InitializeTransferFeeConfig (0): COption
 * config authority, COption withdraw-withheld authority, u16 basis points,
 * u64 maximum fee. Accounts: [mint, writable]. Must come before
 * InitializeMint2 (transfer_fee/instruction.rs lines 26-28). The program
 * refuses basis points above MAX_FEE_BASIS_POINTS
 * (program/src/extension/transfer_fee/processor.rs lines 47-49); so does this
 * encoder.
 */
export function initializeTransferFeeConfig(params: {
  mint: Uint8Array;
  transferFeeConfigAuthority: Uint8Array | null;
  withdrawWithheldAuthority: Uint8Array | null;
  basisPoints: number;
  maximumFee: bigint;
}): SolanaInstruction {
  const { mint, transferFeeConfigAuthority, withdrawWithheldAuthority, basisPoints, maximumFee } = params;
  if (basisPoints > MAX_FEE_BASIS_POINTS) throw new Error('basis points above 10,000');
  if (maximumFee < 0n) throw new Error('the maximum fee must be non-negative');
  return {
    programId: TOKEN_2022_PROGRAM_ID,
    keys: writableMint(mint),
    data: concatBytes(
      Uint8Array.of(26, 0),
      packPubkeyOption(transferFeeConfigAuthority),
      packPubkeyOption(withdrawWithheldAuthority),
      u16ToLeBytes(basisPoints),
      u64ToLeBytes(maximumFee),
    ),
  };
}

/**
 * MetadataPointerExtension (39) / Initialize (0): authority and metadata
 * address, each MaybeNull (64 bytes of Pod data). Accounts: [mint,
 * writable]. Must come before InitializeMint2.
 */
export function initializeMetadataPointer(params: {
  mint: Uint8Array;
  authority: Uint8Array | null;
  metadataAddress: Uint8Array | null;
}): SolanaInstruction {
  const { mint, authority, metadataAddress } = params;
  return {
    programId: TOKEN_2022_PROGRAM_ID,
    keys: writableMint(mint),
    data: concatBytes(Uint8Array.of(39, 0), maybeNullKey(authority), maybeNullKey(metadataAddress)),
  };
}

/**
 * InitializeMint2 (20): decimals u8, mint authority (32), COption freeze
 * authority. Accounts: [mint, writable]; no Rent sysvar
 * (instruction.rs lines 883-892 and 1360-1380).
 */
export function initializeMint2(params: {
  mint: Uint8Array;
  decimals: number;
  mintAuthority: Uint8Array;
  freezeAuthority: Uint8Array | null;
  tokenProgramId?: Uint8Array;
}): SolanaInstruction {
  const { mint, decimals, mintAuthority, freezeAuthority } = params;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('decimals must be an integer in 0..255');
  }
  checkKey(mintAuthority, 'the mint authority');
  return {
    programId: params.tokenProgramId ?? TOKEN_2022_PROGRAM_ID,
    keys: writableMint(mint),
    data: concatBytes(Uint8Array.of(20, decimals), mintAuthority, packPubkeyOption(freezeAuthority)),
  };
}

/**
 * MintToChecked (14): amount u64, decimals u8. Accounts: [mint writable,
 * destination writable, mint authority signer] (instruction.rs lines
 * 858-862 and 1861-1888).
 */
export function mintToChecked(params: {
  mint: Uint8Array;
  destination: Uint8Array;
  authority: Uint8Array;
  amount: bigint;
  decimals: number;
  tokenProgramId?: Uint8Array;
}): SolanaInstruction {
  const { mint, destination, authority, amount, decimals } = params;
  if (amount < 0n) throw new Error('the amount must be non-negative');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('decimals must be an integer in 0..255');
  }
  checkKey(destination, 'the destination');
  checkKey(authority, 'the mint authority');
  return {
    programId: params.tokenProgramId ?? TOKEN_2022_PROGRAM_ID,
    keys: [
      ...writableMint(mint),
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concatBytes(Uint8Array.of(14), u64ToLeBytes(amount), Uint8Array.of(decimals)),
  };
}

/**
 * The token-metadata interface's Initialize discriminator: the first 8
 * bytes of sha256("spl_token_metadata_interface:initialize_account")
 * (the SplDiscriminate hash input on the Initialize struct).
 */
export const TOKEN_METADATA_INITIALIZE_DISCRIMINATOR: Uint8Array = sha256(
  new TextEncoder().encode('spl_token_metadata_interface:initialize_account'),
).slice(0, 8);

function borshString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes(u32ToLeBytes(bytes.length), bytes);
}

/**
 * Token-metadata Initialize, served by Token-2022 for metadata kept in the
 * mint itself: discriminator, then name, symbol and uri as Borsh strings.
 * Accounts: [metadata (= the mint) writable, update authority, mint, mint
 * authority signer]. The mint must already have a MetadataPointer and hold
 * enough lamports for its size AFTER the metadata is written (the program
 * reallocates but adds no lamports).
 */
export function initializeTokenMetadata(params: {
  mint: Uint8Array;
  updateAuthority: Uint8Array;
  mintAuthority: Uint8Array;
  name: string;
  symbol: string;
  uri: string;
}): SolanaInstruction {
  const { mint, updateAuthority, mintAuthority, name, symbol, uri } = params;
  checkKey(mint, 'the mint');
  checkKey(updateAuthority, 'the update authority');
  checkKey(mintAuthority, 'the mint authority');
  return {
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
    ],
    data: concatBytes(TOKEN_METADATA_INITIALIZE_DISCRIMINATOR, borshString(name), borshString(symbol), borshString(uri)),
  };
}

/**
 * Value length of a TokenMetadata TLV entry with no additional metadata
 * (token-metadata interface/src/state.rs, Borsh): update authority (32),
 * mint (32), three Borsh strings, and an empty additional-metadata vector
 * (a u32 count of 0).
 */
export function tokenMetadataLength(name: string, symbol: string, uri: string): number {
  const len = (s: string): number => 4 + new TextEncoder().encode(s).length;
  return 64 + len(name) + len(symbol) + len(uri) + 4;
}

/** Value lengths of the fixed-size mint extensions this module can set up. */
const MINT_EXTENSION_LENGTHS: Readonly<Record<number, number>> = Object.freeze({
  [EXT.TransferFeeConfig]: 108,
  [EXT.MetadataPointer]: 64,
});

/**
 * Data length of a Token-2022 mint carrying the given fixed-size
 * extensions (plus `variableBytes` of further TLV value, e.g. TokenMetadata
 * written later): the 165-byte base (82 mint bytes and 83 of padding), the
 * account-type byte, then 4 + value length per extension
 * (transfer_fee/instruction.rs lines 30-32). Only TransferFeeConfig and
 * MetadataPointer are known here.
 */
export function mintLengthWithExtensions(types: readonly number[], variableValueLengths: readonly number[] = []): number {
  let total = TOKEN_ACCOUNT_BASE_LENGTH + 1;
  for (const type of types) {
    const length = MINT_EXTENSION_LENGTHS[type];
    if (length === undefined) throw new Error(`extension ${type} is not supported by this helper`);
    total += 4 + length;
  }
  for (const length of variableValueLengths) total += 4 + length;
  if (total === 355) throw new Error('a 355-byte mint would need padding this helper does not add');
  return total;
}

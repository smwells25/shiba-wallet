import { base58 } from '@scure/base';
import { bytesEqual } from './encoding.js';
import { TOKEN_PROGRAM_ID } from './splToken.js';

/**
 * Token-2022 (Token Extensions) account parsing and mint classification.
 * Pure and offline: everything here reads bytes the caller already fetched.
 *
 * Sources, all read on 2026-11-07:
 *
 * - solana-program/token-2022 at commit 5170695d8c3958456dde0c4196c55aad362331e5
 *   (interface/src/lib.rs, state.rs, extension/mod.rs and the extension
 *   modules named at each definition below).
 * - The Token Extensions documentation, solana-foundation/solana-com at
 *   commit 31f66e08e6c37c8080ca05e554ff798a4beb82fc,
 *   apps/docs/content/docs/en/tokens/extensions/*.mdx (published at
 *   https://solana.com/docs/tokens/extensions).
 * - solana-program/token-metadata at commit
 *   c1fe5e81cdb55648cd2013652a1a63cd4ec77357 (interface/src/state.rs) for
 *   the TokenMetadata extension's layout.
 * - metaplex-foundation/mpl-token-metadata at commit
 *   72bd052b000aa042126d392edcb7a694d6c04107 for the Metaplex metadata
 *   account (programs/token-metadata/program/src: lib.rs, pda.rs,
 *   state/metadata.rs, state/mod.rs).
 *
 * The wallet's rule: a mint whose behaviour the wallet cannot represent
 * honestly is REFUSED with a plain sentence. It never silently pays an
 * issuer's transfer fee and never calls a transfer-hook program it does not
 * know.
 */

/**
 * The Token Extensions (Token-2022) program id. Verified against
 * token-2022 interface/src/lib.rs line 29,
 * `solana_address::declare_id!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")`;
 * the installed @solana/spl-token 0.4.15 exports the same value as
 * TOKEN_2022_PROGRAM_ID.
 */
export const TOKEN_2022_PROGRAM_ID: Uint8Array = base58.decode(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

/**
 * The Metaplex Token Metadata program id. Verified against
 * mpl-token-metadata programs/token-metadata/program/src/lib.rs line 25,
 * `solana_program::declare_id!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")`.
 */
export const METAPLEX_TOKEN_METADATA_PROGRAM_ID: Uint8Array = base58.decode(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/** Which of the two token programs owns a mint or token account. */
export type TokenProgramKind = 'spl-token' | 'token-2022';

/** Returns the program kind for a 32-byte program id, or null for any other program. */
export function tokenProgramKind(programId: Uint8Array): TokenProgramKind | null {
  if (bytesEqual(programId, TOKEN_PROGRAM_ID)) return 'spl-token';
  if (bytesEqual(programId, TOKEN_2022_PROGRAM_ID)) return 'token-2022';
  return null;
}

/** The 32-byte program id for a program kind. */
export function tokenProgramId(kind: TokenProgramKind): Uint8Array {
  return kind === 'spl-token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

/**
 * Extension type numbers, in the order of token-2022
 * interface/src/extension/mod.rs `pub enum ExtensionType` (lines
 * 1074-1141, `#[repr(u16)]`, implicit discriminants counting from 0). The
 * test-only variants at u16::MAX - 2.. are never valid on a real chain and
 * are not listed. A number missing from this table is an extension this
 * wallet does not know.
 */
export const TOKEN_EXTENSION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'Uninitialized',
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  13: 'NonTransferableAccount',
  14: 'TransferHook',
  15: 'TransferHookAccount',
  16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
  25: 'ScaledUiAmount',
  26: 'Pausable',
  27: 'PausableAccount',
  28: 'PermissionedBurn',
});

/** Extension numbers used by name below. */
export const EXT = Object.freeze({
  TransferFeeConfig: 1,
  TransferFeeAmount: 2,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  ConfidentialTransferAccount: 5,
  DefaultAccountState: 6,
  ImmutableOwner: 7,
  MemoTransfer: 8,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  CpiGuard: 11,
  PermanentDelegate: 12,
  NonTransferableAccount: 13,
  TransferHook: 14,
  TransferHookAccount: 15,
  ConfidentialTransferFeeConfig: 16,
  ConfidentialTransferFeeAmount: 17,
  MetadataPointer: 18,
  TokenMetadata: 19,
  GroupPointer: 20,
  TokenGroup: 21,
  GroupMemberPointer: 22,
  TokenGroupMember: 23,
  ConfidentialMintBurn: 24,
  ScaledUiAmount: 25,
  Pausable: 26,
  PausableAccount: 27,
  PermissionedBurn: 28,
});

/**
 * Mint-side extensions per token-2022 extension/mod.rs get_account_type
 * (lines 1254-1275). Every other known number except 0 is an account-side
 * extension (lines 1276-1284).
 */
const MINT_EXTENSIONS: ReadonlySet<number> = new Set([
  1, 3, 4, 6, 9, 10, 12, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28,
]);

/** One TLV entry from a Token-2022 account. */
export interface TokenExtension {
  /** The u16 extension type number. */
  type: number;
  /** The name from TOKEN_EXTENSION_NAMES, or null when this wallet does not know the number. */
  name: string | null;
  /** The extension's value bytes (a copy). */
  data: Uint8Array;
}

/**
 * Size of a classic Mint (token-2022 state.rs line 50, `const LEN: usize = 82`)
 * and of a token Account (state.rs line 147, `const LEN: usize = 165`).
 */
export const MINT_BASE_LENGTH = 82;
export const TOKEN_ACCOUNT_BASE_LENGTH = 165;
/**
 * A Multisig account is 355 bytes and is never extensible
 * (extension/mod.rs check_min_len_and_not_multisig); an extended mint or
 * account of exactly that size gets a 4-byte Uninitialized padding entry
 * (the ExtensionType::Uninitialized doc comment).
 */
const MULTISIG_LENGTH = 355;

/** AccountType byte values (extension/mod.rs `pub enum AccountType`, lines 1056-1064). */
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;

function readU16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) +
    data[offset + 3]! * 0x1000000
  );
}

function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
}

/**
 * A COption<Pubkey> as packed by token state.rs (unpack_coption_key): a
 * 4-byte little-endian tag (0 = None, 1 = Some) and 32 bytes.
 */
function readCOptionKey(data: Uint8Array, offset: number): string | null {
  const tag = readU32(data, offset);
  if (tag === 0) return null;
  if (tag === 1) return base58.encode(data.slice(offset + 4, offset + 36));
  throw new Error('malformed account data: an optional key has an invalid tag');
}

/**
 * MaybeNull<Address> / OptionalNonZeroPubkey: 32 bytes where all zeros
 * means "none" (used by every Token-2022 extension that stores a key).
 */
function readMaybeNullKey(data: Uint8Array, offset: number): string | null {
  const key = data.slice(offset, offset + 32);
  if (key.length !== 32) throw new Error('malformed extension: a key is cut short');
  return key.every((b) => b === 0) ? null : base58.encode(key);
}

/**
 * Walks the TLV region the same way token-2022 extension/mod.rs
 * try_for_each_tlv_extension_type does (lines 205-238): u16 type, u16
 * length, value; an Uninitialized (0) type ends the list; fewer than 2
 * bytes left also ends it; a length running past the buffer is malformed.
 * Unlike the program, an unknown type number is kept (with name null) so
 * the wallet can refuse it by name instead of failing to read the account.
 */
function parseTlv(tlv: Uint8Array): TokenExtension[] {
  const out: TokenExtension[] = [];
  let i = 0;
  while (i < tlv.length) {
    if (tlv.length < i + 2) break;
    const type = readU16(tlv, i);
    if (type === 0) break;
    if (tlv.length < i + 4) throw new Error('malformed extension data: an entry has no length');
    const length = readU16(tlv, i + 2);
    const end = i + 4 + length;
    if (end > tlv.length) throw new Error('malformed extension data: an entry runs past the account');
    out.push({ type, name: TOKEN_EXTENSION_NAMES[type] ?? null, data: tlv.slice(i + 4, end) });
    i = end;
  }
  return out;
}

/**
 * Extension data starts after the 165-byte base, with the AccountType byte
 * at offset 165 (extension/mod.rs type_and_tlv_indices, lines 316-334, and
 * the comment above check_min_len_and_not_multisig): for a mint the 83
 * bytes after its 82-byte base are padding that must be zero.
 */
function extensionsAfterBase(
  data: Uint8Array,
  baseLength: number,
  expectedAccountType: number,
): TokenExtension[] {
  if (data.length === MULTISIG_LENGTH) {
    throw new Error('malformed account data: 355 bytes is the multisig size');
  }
  if (data.length < TOKEN_ACCOUNT_BASE_LENGTH + 1) {
    throw new Error('malformed account data: too short to carry extensions');
  }
  for (let i = baseLength; i < TOKEN_ACCOUNT_BASE_LENGTH; i++) {
    if (data[i] !== 0) throw new Error('malformed account data: the padding is not zero');
  }
  if (data[TOKEN_ACCOUNT_BASE_LENGTH] !== expectedAccountType) {
    throw new Error('malformed account data: the account type byte does not match');
  }
  return parseTlv(data.slice(TOKEN_ACCOUNT_BASE_LENGTH + 1));
}

/** A parsed mint account of either token program. */
export interface ParsedMint {
  program: TokenProgramKind;
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: string | null;
  extensions: TokenExtension[];
}

/**
 * Parses a mint's raw account data. Layout from token-2022 state.rs lines
 * 49-71 (identical in the classic program): COption mint authority (36),
 * supply u64 (8), decimals u8 (1), is_initialized bool (1), COption freeze
 * authority (36). A classic mint must be exactly 82 bytes; a Token-2022
 * mint is 82 bytes or carries extensions after offset 165.
 */
export function parseMint(data: Uint8Array, program: TokenProgramKind): ParsedMint {
  if (data.length < MINT_BASE_LENGTH) throw new Error('not a mint: account data is too short');
  if (program === 'spl-token' && data.length !== MINT_BASE_LENGTH) {
    throw new Error('not a mint: a classic SPL Token mint is exactly 82 bytes');
  }
  const initializedByte = data[45]!;
  if (initializedByte > 1) throw new Error('not a mint: the initialized flag is not a boolean');
  const extensions =
    data.length === MINT_BASE_LENGTH ? [] : extensionsAfterBase(data, MINT_BASE_LENGTH, ACCOUNT_TYPE_MINT);
  for (const ext of extensions) {
    if (ext.name !== null && !MINT_EXTENSIONS.has(ext.type)) {
      throw new Error(`malformed mint: it carries the account extension ${ext.name}`);
    }
  }
  return {
    program,
    mintAuthority: readCOptionKey(data, 0),
    supply: readU64(data, 36),
    decimals: data[44]!,
    isInitialized: initializedByte === 1,
    freezeAuthority: readCOptionKey(data, 46),
    extensions,
  };
}

/** Token account states (token-2022 state.rs `pub enum AccountState`, lines 203-214). */
export type TokenAccountState = 'uninitialized' | 'initialized' | 'frozen';

/** A parsed token (holding) account of either token program. */
export interface ParsedTokenAccount {
  program: TokenProgramKind;
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  state: TokenAccountState;
  /** Non-null for a wrapped-SOL account: its rent-exempt reserve in lamports. */
  isNative: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: string | null;
  extensions: TokenExtension[];
}

/**
 * Parses a token account's raw data. Layout from token-2022 state.rs lines
 * 146-158: mint (32), owner (32), amount u64 (8), COption delegate (36),
 * state u8 (1), COption<u64> is_native (12), delegated amount u64 (8),
 * COption close authority (36) — 165 bytes, extensions after offset 165
 * with account type 2.
 */
export function parseTokenAccount(data: Uint8Array, program: TokenProgramKind): ParsedTokenAccount {
  if (data.length < TOKEN_ACCOUNT_BASE_LENGTH) {
    throw new Error('not a token account: account data is too short');
  }
  if (program === 'spl-token' && data.length !== TOKEN_ACCOUNT_BASE_LENGTH) {
    throw new Error('not a token account: a classic SPL Token account is exactly 165 bytes');
  }
  const stateByte = data[108]!;
  const state: TokenAccountState | undefined = (['uninitialized', 'initialized', 'frozen'] as const)[
    stateByte
  ];
  if (state === undefined) throw new Error('not a token account: unknown account state');
  const nativeTag = readU32(data, 109);
  if (nativeTag > 1) throw new Error('malformed account data: an optional amount has an invalid tag');
  const extensions =
    data.length === TOKEN_ACCOUNT_BASE_LENGTH
      ? []
      : extensionsAfterBase(data, TOKEN_ACCOUNT_BASE_LENGTH, ACCOUNT_TYPE_ACCOUNT);
  for (const ext of extensions) {
    if (MINT_EXTENSIONS.has(ext.type)) {
      throw new Error(`malformed token account: it carries the mint extension ${ext.name}`);
    }
  }
  return {
    program,
    mint: base58.encode(data.slice(0, 32)),
    owner: base58.encode(data.slice(32, 64)),
    amount: readU64(data, 64),
    delegate: readCOptionKey(data, 72),
    state,
    isNative: nativeTag === 1 ? readU64(data, 113) : null,
    delegatedAmount: readU64(data, 121),
    closeAuthority: readCOptionKey(data, 129),
    extensions,
  };
}

/** Returns the first extension of a type, or undefined. */
export function findExtension(
  extensions: readonly TokenExtension[],
  type: number,
): TokenExtension | undefined {
  return extensions.find((e) => e.type === type);
}

/** One side of a TransferFeeConfig (transfer_fee/mod.rs `struct TransferFee`, lines 34-42). */
export interface TransferFeeRate {
  epoch: bigint;
  maximumFee: bigint;
  basisPoints: number;
}

/** The TransferFeeConfig extension (transfer_fee/mod.rs lines 135-149; 108 bytes). */
export interface TransferFeeConfig {
  transferFeeConfigAuthority: string | null;
  withdrawWithheldAuthority: string | null;
  withheldAmount: bigint;
  olderTransferFee: TransferFeeRate;
  newerTransferFee: TransferFeeRate;
}

function readFeeRate(data: Uint8Array, offset: number): TransferFeeRate {
  return {
    epoch: readU64(data, offset),
    maximumFee: readU64(data, offset + 8),
    basisPoints: readU16(data, offset + 16),
  };
}

export function decodeTransferFeeConfig(ext: TokenExtension): TransferFeeConfig {
  if (ext.data.length !== 108) throw new Error('malformed TransferFeeConfig extension');
  return {
    transferFeeConfigAuthority: readMaybeNullKey(ext.data, 0),
    withdrawWithheldAuthority: readMaybeNullKey(ext.data, 32),
    withheldAmount: readU64(ext.data, 64),
    olderTransferFee: readFeeRate(ext.data, 72),
    newerTransferFee: readFeeRate(ext.data, 90),
  };
}

/** MAX_FEE_BASIS_POINTS (transfer_fee/mod.rs line 26). */
export const MAX_FEE_BASIS_POINTS = 10_000;

/** The fee rate in force at an epoch (TransferFeeConfig::get_epoch_fee, lines 152-158). */
export function transferFeeRateAt(config: TransferFeeConfig, epoch: bigint): TransferFeeRate {
  return epoch >= config.newerTransferFee.epoch ? config.newerTransferFee : config.olderTransferFee;
}

/**
 * The fee withheld from a transfer of `amount` base units, exactly as
 * TransferFee::calculate_fee (transfer_fee/mod.rs lines 50-70):
 * min(maximum_fee, ceil(amount × basis points / 10,000)), and 0 when either
 * the rate or the amount is 0.
 */
export function calculateTransferFee(rate: TransferFeeRate, amount: bigint): bigint {
  if (rate.basisPoints === 0 || amount === 0n) return 0n;
  const numerator = amount * BigInt(rate.basisPoints);
  const ceil = (numerator + BigInt(MAX_FEE_BASIS_POINTS) - 1n) / BigInt(MAX_FEE_BASIS_POINTS);
  return ceil < rate.maximumFee ? ceil : rate.maximumFee;
}

/** TransferHook extension (transfer_hook/mod.rs lines 30-37): authority, program id. */
export function decodeTransferHook(ext: TokenExtension): {
  authority: string | null;
  programId: string | null;
} {
  if (ext.data.length !== 64) throw new Error('malformed TransferHook extension');
  return { authority: readMaybeNullKey(ext.data, 0), programId: readMaybeNullKey(ext.data, 32) };
}

/** PermanentDelegate extension (permanent_delegate.rs lines 18-22). */
export function decodePermanentDelegate(ext: TokenExtension): string | null {
  if (ext.data.length !== 32) throw new Error('malformed PermanentDelegate extension');
  return readMaybeNullKey(ext.data, 0);
}

/** DefaultAccountState extension (default_account_state/mod.rs lines 16-24): one AccountState byte. */
export function decodeDefaultAccountState(ext: TokenExtension): TokenAccountState {
  const state = (['uninitialized', 'initialized', 'frozen'] as const)[ext.data[0] ?? 255];
  if (ext.data.length !== 1 || state === undefined) {
    throw new Error('malformed DefaultAccountState extension');
  }
  return state;
}

/** PausableConfig extension (pausable/mod.rs lines 22-28): authority, paused flag. */
export function decodePausable(ext: TokenExtension): { authority: string | null; paused: boolean } {
  if (ext.data.length !== 33 || ext.data[32]! > 1) throw new Error('malformed Pausable extension');
  return { authority: readMaybeNullKey(ext.data, 0), paused: ext.data[32] === 1 };
}

/** MemoTransfer account extension (memo_transfer/mod.rs lines 17-20): one bool. */
export function decodeMemoTransfer(ext: TokenExtension): { requireIncomingTransferMemos: boolean } {
  if (ext.data.length !== 1 || ext.data[0]! > 1) throw new Error('malformed MemoTransfer extension');
  return { requireIncomingTransferMemos: ext.data[0] === 1 };
}

/** MetadataPointer extension (metadata_pointer/mod.rs lines 21-28): authority, metadata address. */
export function decodeMetadataPointer(ext: TokenExtension): {
  authority: string | null;
  metadataAddress: string | null;
} {
  if (ext.data.length !== 64) throw new Error('malformed MetadataPointer extension');
  return { authority: readMaybeNullKey(ext.data, 0), metadataAddress: readMaybeNullKey(ext.data, 32) };
}

/** Name, symbol and URI as the issuer wrote them (not yet made safe to show). */
export interface RawTokenMetadata {
  /** The mint the metadata says it belongs to. */
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  /** Which on-chain record the text came from. */
  source: 'token-2022-extension' | 'metaplex';
}

/** Reads a Borsh string: a u32 little-endian byte length, then UTF-8 bytes. */
function readBorshString(data: Uint8Array, offset: number, maxBytes: number): { value: string; next: number } {
  if (offset + 4 > data.length) throw new Error('malformed metadata: a string has no length');
  const length = readU32(data, offset);
  if (length > maxBytes || offset + 4 + length > data.length) {
    throw new Error('malformed metadata: a string runs past the record');
  }
  const value = new TextDecoder('utf-8', { fatal: true }).decode(data.slice(offset + 4, offset + 4 + length));
  return { value, next: offset + 4 + length };
}

/**
 * TokenMetadata extension (token-metadata interface/src/state.rs lines
 * 28-43, Borsh): update_authority MaybeNull<Address> (32), mint Address
 * (32), name, symbol, uri (Borsh strings), additional_metadata (ignored
 * here). The mint field exists "to counter spoofing" (the struct's own
 * comment): the caller must compare it with the mint it read.
 */
export function decodeTokenMetadataExtension(ext: TokenExtension): RawTokenMetadata {
  if (ext.data.length < 64) throw new Error('malformed TokenMetadata extension');
  const mint = base58.encode(ext.data.slice(32, 64));
  const name = readBorshString(ext.data, 64, 1024);
  const symbol = readBorshString(ext.data, name.next, 1024);
  const uri = readBorshString(ext.data, symbol.next, 4096);
  return { mint, name: name.value, symbol: symbol.value, uri: uri.value, source: 'token-2022-extension' };
}

/**
 * Metaplex metadata account: key u8 (MetadataV1 = 4, the fifth variant of
 * `pub enum Key` in state/mod.rs lines 142-158), update_authority (32),
 * mint (32), then Data { name, symbol, uri, ... } as Borsh strings
 * (state/metadata.rs lines 68-78, state/data.rs lines 6-17). Metaplex pads
 * the strings with NUL bytes to their maximum lengths (32, 10, 200 —
 * state/metadata.rs lines 16-20), so trailing NULs are dropped.
 */
export function decodeMetaplexMetadata(data: Uint8Array): RawTokenMetadata {
  if (data.length < 65 || data[0] !== 4) throw new Error('not a Metaplex metadata account');
  const mint = base58.encode(data.slice(33, 65));
  const name = readBorshString(data, 65, 1024);
  const symbol = readBorshString(data, name.next, 1024);
  const uri = readBorshString(data, symbol.next, 4096);
  const strip = (s: string): string => s.replace(/\u0000+$/u, '');
  return { mint, name: strip(name.value), symbol: strip(symbol.value), uri: strip(uri.value), source: 'metaplex' };
}

/**
 * Makes issuer-written text safe to show: control, bidirectional and
 * zero-width characters removed (the same character classes as the app's
 * simulation.ts sanitizeSymbol), trimmed, capped. Returns null when nothing
 * printable is left. Anyone can create a mint and give it any name or
 * symbol, so this text is never proof of what a token is.
 */
export function sanitizeTokenText(raw: string, maxLength: number): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/gu, '')
    .trim();
  if (cleaned === '') return null;
  const chars = [...cleaned];
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : cleaned;
}

/**
 * How the wallet treats a mint when sending it:
 *
 * - plain: TransferChecked, nothing else happens on a transfer.
 * - fee-charging: the mint has a TransferFeeConfig; the wallet sends with
 *   TransferCheckedWithFee and states the fee (possibly 0) on the quote.
 * - hook-bearing: a transfer hook program is set — refused.
 * - non-transferable: refused.
 * - paused: the mint is paused — refused.
 * - display-adjusted: interest-bearing or scaled UI amount — refused,
 *   because the issuer's documentation says users should see an adjusted
 *   amount this wallet does not compute.
 * - unknown-extension: an extension number this wallet does not know — refused.
 * - not-a-mint: uninitialized — refused.
 */
export type MintTransferClass =
  | 'plain'
  | 'fee-charging'
  | 'hook-bearing'
  | 'non-transferable'
  | 'paused'
  | 'display-adjusted'
  | 'unknown-extension'
  | 'not-a-mint';

/** The result of classifying a mint. */
export interface MintClassification {
  transferClass: MintTransferClass;
  /** The refusal sentence when the class is refused; null when it can be sent. */
  refusal: string | null;
  /** Plain sentences the wallet must show beside any quote for this mint. */
  notes: string[];
  /** Decoded when the mint has a TransferFeeConfig. */
  transferFee: TransferFeeConfig | null;
  /** Account state given to new token accounts (DefaultAccountState), when set. */
  defaultAccountState: TokenAccountState | null;
}

/** Refusal and note sentences, exported so the app and the checks pin the exact text. */
export const SPL_SENTENCES = Object.freeze({
  notAMint: 'This address is not an initialized token mint, so nothing can be sent with it.',
  nonTransferable:
    'This token is non-transferable: its issuer made it impossible to move to another account, so it cannot be sent.',
  hook: (program: string): string =>
    `This token runs the issuer's program ${program} on every transfer (a transfer hook). This wallet does not call programs it does not know, so it does not send this token.`,
  paused: 'The issuer has paused this token, so transfers are refused until the issuer resumes it.',
  displayAdjusted: (name: string): string =>
    `This token uses the ${name} extension, which changes the amount people are meant to see from the amount actually stored. This wallet does not compute that adjusted amount yet, so it does not send this token rather than show a misleading figure.`,
  unknownExtension: (types: string): string =>
    `This token uses Token-2022 extension number ${types}, which this wallet does not know. It does not send a token whose behaviour it cannot describe.`,
  feeNote: (bps: number, max: string): string =>
    `The issuer charges a transfer fee of ${bps} basis points (at most ${max} base units per transfer), taken out of the amount the recipient receives. The issuer can change the fee; a change takes effect two epochs after it is made.`,
  feeZeroNote:
    'The issuer has a transfer-fee setting on this token that is 0 today. The issuer can set a fee; a change takes effect two epochs after it is made, and the wallet re-reads it before every transfer.',
  permanentDelegate: (delegate: string): string =>
    `The issuer's permanent delegate ${delegate} can move or burn this token from any account, including yours, at any time; you cannot revoke it.`,
  freezeAuthority: (authority: string): string =>
    `The freeze authority ${authority} can freeze any account holding this token, after which it cannot be sent.`,
  mintCloseAuthority: 'The issuer can close this mint once no tokens are left in circulation.',
  pausable: 'The issuer can pause this token; while it is paused no transfer goes through.',
  hookUnset:
    'The issuer can switch on a transfer hook for this token later; if that happens, this wallet will stop sending it.',
  defaultFrozen:
    "New accounts for this token start frozen until the issuer thaws them, so a recipient who does not already hold it cannot receive it from this wallet.",
  confidential:
    'This token allows confidential (encrypted) balances. This wallet sees and sends only the public balance; an encrypted balance is not shown.',
});

const DISPLAY_ADJUSTED = new Set<number>([EXT.InterestBearingConfig, EXT.ScaledUiAmount]);
const CONFIDENTIAL = new Set<number>([
  EXT.ConfidentialTransferMint,
  EXT.ConfidentialTransferFeeConfig,
  EXT.ConfidentialMintBurn,
]);

/**
 * Classifies a parsed mint by its extensions. Refusals come first in a
 * fixed order (not initialized, unknown, non-transferable, hook, paused,
 * display-adjusted), so a mint carrying several refused extensions always
 * gets the same sentence. Sources for each rule:
 *
 * - NonTransferable: non-transferrable-tokens.mdx, "token holders cannot
 *   move them to another token account with Transfer or TransferChecked".
 * - TransferHook: transfer-hook-integration.mdx, "every transfer of that
 *   token requires the hook's extra accounts … the transfer instruction
 *   fails onchain". A hook whose program id is all zeros is not set
 *   (MaybeNull), so it calls nothing.
 * - Pausable: pausable.mdx, "When a mint is paused, the Token Extension
 *   Program rejects: Transfers".
 * - InterestBearingConfig / ScaledUiAmount: interest-bearing-tokens.mdx
 *   ("the calculated UI amount with interest can increase even though the
 *   token amount … stay[s] the same") and scaled-ui-amount
 *   integration-guide.mdx ("End users should interact with the UIAmount").
 * - TransferFeeConfig: transfer-fees.mdx, "Use TransferCheckedWithFee to
 *   transfer tokens and verify the expected fee" and "SetTransferFee …
 *   takes effect starting two epochs later".
 * - PermanentDelegate: permanent-delegate.mdx, "can authorize transfers
 *   and burns for any token account … owners cannot revoke".
 * - DefaultAccountState: default-state.mdx, "Token accounts that start
 *   frozen cannot be used until the mint's freeze authority thaws them".
 */
export function classifyMint(mint: ParsedMint): MintClassification {
  const notes: string[] = [];
  const result = (
    transferClass: MintTransferClass,
    refusal: string | null,
    transferFee: TransferFeeConfig | null = null,
    defaultAccountState: TokenAccountState | null = null,
  ): MintClassification => ({ transferClass, refusal, notes, transferFee, defaultAccountState });

  if (!mint.isInitialized) return result('not-a-mint', SPL_SENTENCES.notAMint);

  const unknown = mint.extensions.filter((e) => e.name === null).map((e) => String(e.type));
  if (unknown.length > 0) {
    return result('unknown-extension', SPL_SENTENCES.unknownExtension(unknown.join(', ')));
  }
  const ext = (type: number): TokenExtension | undefined => findExtension(mint.extensions, type);

  if (ext(EXT.NonTransferable)) return result('non-transferable', SPL_SENTENCES.nonTransferable);

  const hookExt = ext(EXT.TransferHook);
  if (hookExt) {
    const hook = decodeTransferHook(hookExt);
    if (hook.programId !== null) return result('hook-bearing', SPL_SENTENCES.hook(hook.programId));
    if (hook.authority !== null) notes.push(SPL_SENTENCES.hookUnset);
  }

  const pausableExt = ext(EXT.Pausable);
  if (pausableExt) {
    if (decodePausable(pausableExt).paused) return result('paused', SPL_SENTENCES.paused);
    notes.push(SPL_SENTENCES.pausable);
  }

  const adjusted = mint.extensions.find((e) => DISPLAY_ADJUSTED.has(e.type));
  if (adjusted) return result('display-adjusted', SPL_SENTENCES.displayAdjusted(adjusted.name!));

  const delegateExt = ext(EXT.PermanentDelegate);
  if (delegateExt) {
    const delegate = decodePermanentDelegate(delegateExt);
    if (delegate !== null) notes.push(SPL_SENTENCES.permanentDelegate(delegate));
  }
  if (mint.freezeAuthority !== null) notes.push(SPL_SENTENCES.freezeAuthority(mint.freezeAuthority));
  if (ext(EXT.MintCloseAuthority)) notes.push(SPL_SENTENCES.mintCloseAuthority);
  if (mint.extensions.some((e) => CONFIDENTIAL.has(e.type))) notes.push(SPL_SENTENCES.confidential);

  let defaultState: TokenAccountState | null = null;
  const defaultExt = ext(EXT.DefaultAccountState);
  if (defaultExt) {
    defaultState = decodeDefaultAccountState(defaultExt);
    if (defaultState === 'frozen') notes.push(SPL_SENTENCES.defaultFrozen);
  }

  const feeExt = ext(EXT.TransferFeeConfig);
  if (feeExt) {
    const fee = decodeTransferFeeConfig(feeExt);
    return result('fee-charging', null, fee, defaultState);
  }
  return result('plain', null, null, defaultState);
}

/**
 * Length of a new associated token account for a mint, as the token
 * program's GetAccountDataSize answers it for the ATA program (the ATA
 * processor asks for [ImmutableOwner] plus the mint's required account
 * extensions: associated-token-account program/src/processor.rs lines
 * 117-121 at commit a63e1598ef7cda6ef7c4133775c775b50e895183).
 *
 * Classic SPL Token: 165. Token-2022: 165 + 1 (account type) + 4 + length
 * for each account extension — ImmutableOwner (0), and per
 * extension/mod.rs required_init_account_extensions (lines 1296-1309):
 * TransferFeeConfig → TransferFeeAmount (8 bytes), NonTransferable →
 * NonTransferableAccount (0), TransferHook → TransferHookAccount (1),
 * Pausable → PausableAccount (0); plus 4 bytes of padding if the total is
 * exactly the 355-byte multisig size.
 */
export function associatedAccountLength(mint: ParsedMint): number {
  if (mint.program === 'spl-token') return TOKEN_ACCOUNT_BASE_LENGTH;
  const lengths = new Map<number, number>([[EXT.ImmutableOwner, 0]]);
  for (const e of mint.extensions) {
    if (e.type === EXT.TransferFeeConfig) lengths.set(EXT.TransferFeeAmount, 8);
    if (e.type === EXT.NonTransferable) {
      lengths.set(EXT.NonTransferableAccount, 0);
      lengths.set(EXT.ImmutableOwner, 0);
    }
    if (e.type === EXT.TransferHook) lengths.set(EXT.TransferHookAccount, 1);
    if (e.type === EXT.Pausable) lengths.set(EXT.PausableAccount, 0);
  }
  let total = TOKEN_ACCOUNT_BASE_LENGTH + 1;
  for (const len of lengths.values()) total += 4 + len;
  return total === MULTISIG_LENGTH ? total + 4 : total;
}

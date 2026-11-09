import { base58 } from '@scure/base';
import { formatAssetId, type AssetId, type FungibleAsset } from '@shiba-wallet/core';
import { bytesEqual, concatBytes, u64ToLeBytes } from './encoding.js';
import type { SolanaInstruction } from './message.js';
import { findProgramAddress, isOnCurve } from './pda.js';
import type { SolanaRpcClient } from './rpc.js';
import {
  createAssociatedTokenAccountIdempotent,
  findAssociatedTokenAddress,
  splTransferChecked,
} from './splToken.js';
import {
  EXT,
  METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  SPL_SENTENCES,
  TOKEN_2022_PROGRAM_ID,
  associatedAccountLength,
  calculateTransferFee,
  classifyMint,
  decodeMemoTransfer,
  decodeMetadataPointer,
  decodeMetaplexMetadata,
  decodeTokenMetadataExtension,
  findExtension,
  parseMint,
  parseTokenAccount,
  sanitizeTokenText,
  tokenProgramId,
  tokenProgramKind,
  transferFeeRateAt,
  type MintClassification,
  type ParsedMint,
  type ParsedTokenAccount,
  type RawTokenMetadata,
  type TokenProgramKind,
} from './tokenExtensions.js';

/**
 * Token-2022-aware token layer: CAIP-19 ids, listing an owner's token
 * accounts across both token programs, reading and classifying a mint, and
 * quoting a transfer (TransferChecked, or TransferCheckedWithFee for a mint
 * with a transfer-fee setting) with the destination associated token
 * account created when it is missing. Network access goes through an
 * injected SolanaRpcClient; nothing here picks an RPC provider.
 */

/**
 * CAIP-2 ids of the Solana clusters, from the ChainAgnostic namespaces
 * repository, solana/caip2.md (commit c70f619fda9c92009c5474391081ea3911773367,
 * read 2026-11-07): the genesis hash truncated to its first 32 characters.
 * "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" is mainnet and
 * "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" devnet (its test cases); the
 * devnet one was confirmed on 2026-11-07 by getGenesisHash on
 * api.devnet.solana.com, which answered
 * "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG".
 */
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** The two CAIP-19 asset namespaces solana/caip19.md defines. */
export type SolanaAssetNamespace = 'token' | 'nft';

/**
 * CAIP-19 id for a Solana mint, per the ChainAgnostic namespaces
 * repository solana/caip19.md (same commit): "we use `token` (fungible) and
 * `nft` (non-fungible) as the asset namespaces and the address of the
 * `mint` account as the reference in both", e.g.
 * solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
 * The same id serves both token programs: the mint address is unique and
 * the program is read from the chain, never from the id.
 */
export function solanaTokenAssetId(
  caip2: string,
  mint: string,
  namespace: SolanaAssetNamespace = 'token',
): AssetId {
  if (!caip2.startsWith('solana:')) throw new Error(`not a Solana chain id: ${caip2}`);
  if (!isValidMintAddress(mint)) throw new Error(`not a Solana mint address: ${mint}`);
  const assetId: AssetId = { chainId: caip2, namespace, reference: mint };
  formatAssetId(assetId); // validates every part through core
  return assetId;
}

/** A base58 string that decodes to 32 bytes. */
function isValidMintAddress(address: string): boolean {
  try {
    return base58.decode(address).length === 32;
  } catch {
    return false;
  }
}

/**
 * A core FungibleAsset for a mint, ready for core's AssetRegistry. The
 * symbol and name are what the caller decided to show (normally the
 * sanitised on-chain metadata or a known-token entry); the decimals must
 * come from the mint itself.
 */
export function solanaFungibleAsset(params: {
  caip2: string;
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}): FungibleAsset {
  return {
    kind: 'fungible',
    assetId: solanaTokenAssetId(params.caip2, params.mint, 'token'),
    symbol: params.symbol,
    name: params.name,
    decimals: params.decimals,
  };
}

/** A token whose mint address this wallet takes from its issuer's own documentation. */
export interface KnownSolanaToken {
  caip2: string;
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  program: TokenProgramKind;
  /** Where the mint address comes from. */
  source: string;
}

/**
 * Mints named in issuer documentation. The devnet USDC and PYUSD mints were
 * read on devnet on 2026-11-07 and both EURC mints on their own cluster on
 * 2026-11-08 (UTC); in each read the owner program and decimals agree with
 * the table:
 *
 * - USDC on devnet 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU: Circle's
 *   "USDC contract addresses" page
 *   (https://developers.circle.com/stablecoins/usdc-contract-addresses,
 *   fetched 2026-11-07, row "Solana Devnet"). Classic SPL Token, 6 decimals.
 * - PYUSD on devnet CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM: Paxos
 *   "PYUSD on Test Networks"
 *   (https://docs.sandbox.paxos.com/guides/stablecoin/pyusd/testnet,
 *   fetched 2026-11-07, row "Solana Devnet"). Token-2022, 6 decimals.
 * - USDC on mainnet EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: Circle's
 *   same page, row "Solana" (also the CAIP-19 namespace document's example).
 *   Read on mainnet with getAccountInfo (base64, finalized) on 2026-11-09
 *   02:48 UTC at slot 467155464 on api.mainnet-beta.solana.com and
 *   solana-rpc.publicnode.com, byte-identical answers: owned by the classic
 *   SPL Token program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, 82 bytes,
 *   6 decimals, initialized, with a mint authority and a freeze authority
 *   set (parseMint and classifyMint: plain, no extensions). Its metadata
 *   (name and symbol) was not read.
 * - EURC on devnet AND on mainnet, HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr:
 *   Circle's "EURC contract addresses" page
 *   (https://developers.circle.com/stablecoins/eurc-contract-addresses,
 *   fetched 2026-11-08 04:09 UTC) lists THE SAME ADDRESS in its "Solana"
 *   (mainnet) row and its "Solana Devnet" row. They are two separate
 *   accounts, one on each cluster, that happen to share an address: read with
 *   getAccountInfo (jsonParsed, finalized) on 2026-11-08 04:09 UTC, both are
 *   initialized mints owned by the classic SPL Token program
 *   TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, 82 bytes, 6 decimals, but
 *   with different mint and freeze authorities and different supplies
 *   (devnet at slot 519895981 on api.devnet.solana.com, mainnet at slot
 *   466775624 on api.mainnet-beta.solana.com). Because the address is the
 *   same, a table entry must always be read together with its network: the
 *   look-alike rule below already matches on the network first. Neither
 *   mint's name or symbol was read on-chain (no Metaplex record was fetched);
 *   "EURC" is the symbol and name Circle's page uses, and the same the
 *   wallet's EVM table uses for Circle's EURC.
 *
 * Used only to flag look-alikes and as the name of a mint with no on-chain
 * metadata; never to fill in decimals.
 */
export const KNOWN_SOLANA_TOKENS: readonly KnownSolanaToken[] = Object.freeze([
  {
    caip2: SOLANA_DEVNET_CAIP2,
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    program: 'spl-token',
    source: 'Circle, USDC contract addresses (Solana Devnet), fetched 2026-11-07',
  },
  {
    caip2: SOLANA_DEVNET_CAIP2,
    mint: 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM',
    symbol: 'PYUSD',
    name: 'PayPal USD',
    decimals: 6,
    program: 'token-2022',
    source: 'Paxos, PYUSD on Test Networks (Solana Devnet), fetched 2026-11-07',
  },
  {
    caip2: SOLANA_MAINNET_CAIP2,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    program: 'spl-token',
    source: 'Circle, USDC contract addresses (Solana), fetched 2026-11-07; read on mainnet 2026-11-09',
  },
  {
    caip2: SOLANA_DEVNET_CAIP2,
    mint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
    symbol: 'EURC',
    name: 'EURC',
    decimals: 6,
    program: 'spl-token',
    source: 'Circle, EURC contract addresses (Solana Devnet), fetched 2026-11-08; read on devnet 2026-11-08',
  },
  {
    caip2: SOLANA_MAINNET_CAIP2,
    mint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
    symbol: 'EURC',
    name: 'EURC',
    decimals: 6,
    program: 'spl-token',
    source: 'Circle, EURC contract addresses (Solana), fetched 2026-11-08; read on mainnet 2026-11-08',
  },
]);

/**
 * The look-alike rule, the same as the app's EVM token discovery: a token
 * whose symbol equals a known token's on the same network (letter case
 * ignored) while its mint differs is flagged. Anyone can create a mint and
 * call it "USDC"; only the mint address identifies the token.
 */
export function findSolanaLookAlike(
  caip2: string,
  mint: string,
  symbol: string | null,
  references: readonly { caip2: string; mint: string; symbol: string }[] = KNOWN_SOLANA_TOKENS,
): { caip2: string; mint: string; symbol: string } | null {
  if (symbol === null) return null;
  const wanted = symbol.trim().toLowerCase();
  if (wanted === '') return null;
  return (
    references.find(
      (r) => r.caip2 === caip2 && r.symbol.toLowerCase() === wanted && r.mint !== mint,
    ) ?? null
  );
}

/** The look-alike warning sentence, exported for the app and the checks. */
export function lookAlikeSentence(symbol: string, knownMint: string): string {
  return `This token calls itself ${symbol}, but it is not the ${symbol} mint this wallet knows (${knownMint}). Anyone can create a token with any name and symbol; only the mint address identifies it.`;
}

/**
 * Builds a Token-2022 TransferCheckedWithFee instruction.
 *
 * Verified against token-2022 interface/src/instruction.rs (commit
 * 5170695d8c3958456dde0c4196c55aad362331e5): TokenInstruction::
 * TransferFeeExtension packs as the byte 26 (pack, lines 914-916; unpack
 * line 1115), followed by the transfer-fee sub-instruction, and
 * extension/transfer_fee/instruction.rs packs TransferCheckedWithFee as 1,
 * amount u64 LE, decimals u8, fee u64 LE (lines 220-229) — 19 bytes in all.
 * Accounts (same file, lines 56-64): source (writable), mint, destination
 * (writable), owner (signer). The program fails the transfer when the fee
 * it computes differs from `fee`, so the fee shown on the quote is the fee
 * charged or nothing happens.
 */
export function transferCheckedWithFee(params: {
  source: Uint8Array;
  mint: Uint8Array;
  destination: Uint8Array;
  owner: Uint8Array;
  amount: bigint;
  decimals: number;
  fee: bigint;
}): SolanaInstruction {
  const { source, mint, destination, owner, amount, decimals, fee } = params;
  if (amount < 0n || fee < 0n) throw new Error('amount and fee must be non-negative');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('decimals must be an integer in 0..255');
  }
  return {
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: concatBytes(
      Uint8Array.of(26, 1),
      u64ToLeBytes(amount),
      Uint8Array.of(decimals),
      u64ToLeBytes(fee),
    ),
  };
}

/**
 * The Metaplex metadata account for a mint: the PDA of
 * ["metadata", program id, mint] under the Token Metadata program
 * (mpl-token-metadata program/src/pda.rs lines 11 and 48-55).
 */
export function findMetaplexMetadataAddress(mint: Uint8Array): Uint8Array {
  return findProgramAddress(
    [new TextEncoder().encode('metadata'), METAPLEX_TOKEN_METADATA_PROGRAM_ID, mint],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  ).address;
}

/** A mint as the wallet understands it. */
export interface MintProfile {
  mint: string;
  program: TokenProgramKind;
  parsed: ParsedMint;
  classification: MintClassification;
  /** Sanitised name and symbol, when an on-chain record names the mint. */
  metadata: { name: string | null; symbol: string | null; source: RawTokenMetadata['source'] } | null;
  /** Why the metadata is null, when it is. */
  metadataNote: string | null;
}

/** A refusal: the exact sentence the wallet shows, with a stable code for tests. */
export class SplTokenRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SplTokenRefusal';
  }
}

/**
 * How the quote's sentences name a token whose mint has no readable symbol
 * (symbolFor below), exported so the checks can pin both wordings.
 */
export const SPL_UNNAMED_TOKEN = 'this token';

/** Refusal sentences of the transfer quote, exported so the checks pin them. */
export const SPL_QUOTE_SENTENCES = Object.freeze({
  notTokenProgram: (owner: string): string =>
    `This address is not a token mint: it belongs to the program ${owner}, not to the SPL Token or Token-2022 program.`,
  mintMissing: 'No account exists at this mint address on this network.',
  badRecipient: 'The recipient is not a valid Solana address.',
  selfSend: 'The recipient is this same account, so nothing would move.',
  offCurve:
    'The recipient address is not an ordinary wallet address (it has no private key; it may be a program-derived address). This wallet does not send tokens to such an address.',
  recipientIsTokenAccount:
    'The recipient address is itself a token account, not a wallet. Sending to it would put the tokens in an account that belongs to whoever owns that token account; ask the recipient for their wallet address.',
  // "holds no PYUSD" for a token with a symbol; a mint without readable
  // metadata has no symbol and is named "this token" (symbolFor), where
  // "holds no this token" would not read as English, so that one case
  // keeps "none of".
  noSourceAccount: (symbol: string): string =>
    symbol === SPL_UNNAMED_TOKEN
      ? `This account holds none of ${symbol} in its associated token account, so there is nothing to send.`
      : `This account holds no ${symbol} in its associated token account, so there is nothing to send.`,
  sourceFrozen: 'Your token account for this token is frozen, so it cannot send until the issuer thaws it.',
  insufficient: (have: string, want: string, symbol: string): string =>
    `Not enough of ${symbol}: the account holds ${have} and this transfer needs ${want}.`,
  zeroAmount: 'Enter an amount greater than zero.',
  decimalsChanged: (expected: number, actual: number): string =>
    `The mint reports ${actual} decimals, not the ${expected} this transfer was prepared with. Nothing was sent; review the amount again.`,
  destinationFrozen: "The recipient's token account for this token is frozen, so it cannot receive.",
  destinationDefaultFrozen:
    "The recipient does not hold this token yet, and new accounts for it start frozen, so the transfer would fail. Nothing was sent.",
  destinationMemo:
    "The recipient's token account requires a memo with every incoming transfer, and this wallet does not add memos yet.",
  destinationConfidential:
    "The recipient's token account is set up for confidential transfers; this wallet cannot tell whether it accepts a plain transfer, so it does not send.",
  destinationMismatch:
    "The recipient's associated token account does not hold this token for this recipient. Nothing was sent.",
  // nativeSymbol names the network's coin as the wallet shows it: "SOL" on
  // mainnet (the default, so every older call reads as before) and
  // "test SOL" on devnet. The amounts stay in lamports either way.
  notEnoughSol: (needed: string, held: string, nativeSymbol: string = 'SOL'): string =>
    `Not enough ${nativeSymbol} for this transfer: it needs ${needed} lamports for the network fee and any new account's rent, and the account holds ${held} lamports.`,
});

/**
 * The base fee per signature, from the official fees page
 * (solana-com apps/docs/content/docs/en/core/fees/index.mdx at 31f66e08,
 * read 2026-11-07): "a base fee of 5,000 lamports per signature". A
 * transfer signed by the owner alone has one signature. Priority fees are
 * not added by this wallet.
 */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Reads and classifies a mint. Refuses an address that does not exist or
 * is not owned by one of the two token programs. Metadata comes from the
 * Token-2022 TokenMetadata extension when the mint's MetadataPointer points
 * at the mint itself and the record names this mint; otherwise from the
 * Metaplex metadata account when one exists and names this mint; a
 * metadata pointer to another account is not followed (stated).
 */
export async function readMintProfile(client: SolanaRpcClient, mint: string): Promise<MintProfile> {
  const account = await client.getAccountInfoBase64(mint);
  if (account === null) throw new SplTokenRefusal('mint-missing', SPL_QUOTE_SENTENCES.mintMissing);
  const program = tokenProgramKind(base58.decode(account.owner));
  if (program === null) {
    throw new SplTokenRefusal('not-token-program', SPL_QUOTE_SENTENCES.notTokenProgram(account.owner));
  }
  let parsed: ParsedMint;
  try {
    parsed = parseMint(account.data, program);
  } catch (error) {
    throw new SplTokenRefusal('not-a-mint', `${SPL_SENTENCES.notAMint} (${(error as Error).message})`);
  }
  const classification = classifyMint(parsed);
  const { metadata, metadataNote } = await readMetadata(client, mint, parsed);
  return { mint, program, parsed, classification, metadata, metadataNote };
}

async function readMetadata(
  client: SolanaRpcClient,
  mint: string,
  parsed: ParsedMint,
): Promise<Pick<MintProfile, 'metadata' | 'metadataNote'>> {
  const fromRaw = (raw: RawTokenMetadata): Pick<MintProfile, 'metadata' | 'metadataNote'> => {
    if (raw.mint !== mint) {
      return { metadata: null, metadataNote: 'The metadata record names a different mint, so it is ignored.' };
    }
    return {
      metadata: {
        name: sanitizeTokenText(raw.name, 32),
        symbol: sanitizeTokenText(raw.symbol, 16),
        source: raw.source,
      },
      metadataNote: null,
    };
  };
  const pointerExt = findExtension(parsed.extensions, EXT.MetadataPointer);
  if (pointerExt) {
    const pointer = decodeMetadataPointer(pointerExt);
    if (pointer.metadataAddress !== null && pointer.metadataAddress !== mint) {
      return {
        metadata: null,
        metadataNote: `The mint points to metadata held in another account (${pointer.metadataAddress}), which this wallet does not read yet.`,
      };
    }
    const own = findExtension(parsed.extensions, EXT.TokenMetadata);
    if (pointer.metadataAddress === mint && own) {
      try {
        return fromRaw(decodeTokenMetadataExtension(own));
      } catch {
        return { metadata: null, metadataNote: "The mint's metadata could not be read." };
      }
    }
  }
  const metaplex = await client.getAccountInfoBase64(
    base58.encode(findMetaplexMetadataAddress(base58.decode(mint))),
  );
  if (metaplex === null || !bytesEqual(base58.decode(metaplex.owner), METAPLEX_TOKEN_METADATA_PROGRAM_ID)) {
    return { metadata: null, metadataNote: 'No on-chain name or symbol was found for this mint.' };
  }
  try {
    return fromRaw(decodeMetaplexMetadata(metaplex.data));
  } catch {
    return { metadata: null, metadataNote: "The mint's metadata could not be read." };
  }
}

/** One of an owner's token accounts, from either program. */
export interface OwnedTokenAccount {
  address: string;
  program: TokenProgramKind;
  /** True when this is the owner's associated token account for its mint and program. */
  isAssociated: boolean;
  account: ParsedTokenAccount;
}

/**
 * Lists every token account the owner holds under both token programs
 * (getTokenAccountsByOwner once per program id). Each answer is parsed
 * from raw bytes and checked: owned by the program queried, its owner
 * field equal to the owner asked about. An entry that fails a check is
 * skipped and counted, never shown.
 */
export async function listOwnerTokenAccounts(
  client: SolanaRpcClient,
  owner: string,
): Promise<{ accounts: OwnedTokenAccount[]; skipped: number }> {
  const ownerBytes = base58.decode(owner);
  if (ownerBytes.length !== 32) throw new Error('owner must be a 32-byte address');
  const accounts: OwnedTokenAccount[] = [];
  let skipped = 0;
  for (const kind of ['spl-token', 'token-2022'] as const) {
    const programId = tokenProgramId(kind);
    const raw = await client.getTokenAccountsByOwnerBase64(owner, base58.encode(programId));
    for (const entry of raw) {
      try {
        if (!bytesEqual(base58.decode(entry.owner), programId)) throw new Error('wrong program');
        const account = parseTokenAccount(entry.data, kind);
        if (account.owner !== owner) throw new Error('wrong owner');
        const ata = findAssociatedTokenAddress({
          owner: ownerBytes,
          mint: base58.decode(account.mint),
          tokenProgramId: programId,
        });
        accounts.push({
          address: entry.address,
          program: kind,
          isAssociated: base58.encode(ata.address) === entry.address,
          account,
        });
      } catch {
        skipped++;
      }
    }
  }
  return { accounts, skipped };
}

/** A quoted token transfer, ready to compile and sign. */
export interface SplTokenTransferQuote {
  assetId: AssetId;
  mint: string;
  program: TokenProgramKind;
  decimals: number;
  /** Base units the sender's account gives up. */
  amount: bigint;
  /** Base units withheld by the issuer's transfer fee (0 for a plain mint). */
  transferFee: bigint;
  /** Base units the recipient's account receives (amount − transferFee). */
  recipientReceives: bigint;
  sourceAccount: string;
  destinationAccount: string;
  /** True when the destination associated token account is created by this transaction. */
  createsDestination: boolean;
  /** Rent the sender pays for the new account (0 when it exists). */
  rentLamports: bigint;
  /** The base network fee (one signature). */
  networkFeeLamports: bigint;
  /** The instructions in order, for compileMessage with the owner as fee payer. */
  instructions: SolanaInstruction[];
  /** Sentences the wallet must show beside the quote. */
  notes: string[];
  profile: MintProfile;
}

function symbolFor(profile: MintProfile): string {
  return profile.metadata?.symbol ?? SPL_UNNAMED_TOKEN;
}

/**
 * Quotes a transfer of `amount` base units of `mint` from `owner` to the
 * wallet `recipient`, reading everything it decides on from the chain:
 * the mint (refusing what classifyMint refuses), the epoch for a transfer
 * fee, the sender's associated token account (it must exist, belong to the
 * owner, not be frozen and hold enough), the recipient (a valid on-curve
 * address that is not itself a token account), the recipient's associated
 * token account (created when missing, refusing a mint whose new accounts
 * start frozen; when it exists it must hold this mint for this recipient,
 * not be frozen, not require a memo and not be set up for confidential
 * transfers), the rent for a new account and the sender's SOL for fee and
 * rent. `expectedDecimals`, when given, must equal the mint's decimals.
 */
export async function quoteSplTokenTransfer(
  client: SolanaRpcClient,
  params: {
    caip2: string;
    owner: string;
    recipient: string;
    mint: string;
    amount: bigint;
    expectedDecimals?: number;
    /**
     * The network's coin as the wallet names it in sentences ("SOL" on
     * mainnet, "test SOL" on devnet). Only the not-enough-SOL refusal uses
     * it; when absent the sentence says "SOL" as before.
     */
    nativeSymbol?: string;
  },
): Promise<SplTokenTransferQuote> {
  const { caip2, owner, recipient, mint, amount, expectedDecimals, nativeSymbol } = params;
  if (amount <= 0n) throw new SplTokenRefusal('zero-amount', SPL_QUOTE_SENTENCES.zeroAmount);

  const profile = await readMintProfile(client, mint);
  const { classification, parsed, program } = profile;
  if (classification.refusal !== null) {
    throw new SplTokenRefusal(classification.transferClass, classification.refusal);
  }
  if (expectedDecimals !== undefined && expectedDecimals !== parsed.decimals) {
    throw new SplTokenRefusal(
      'decimals-changed',
      SPL_QUOTE_SENTENCES.decimalsChanged(expectedDecimals, parsed.decimals),
    );
  }

  let recipientBytes: Uint8Array;
  try {
    recipientBytes = base58.decode(recipient);
  } catch {
    throw new SplTokenRefusal('bad-recipient', SPL_QUOTE_SENTENCES.badRecipient);
  }
  if (recipientBytes.length !== 32) throw new SplTokenRefusal('bad-recipient', SPL_QUOTE_SENTENCES.badRecipient);
  if (recipient === owner) throw new SplTokenRefusal('self-send', SPL_QUOTE_SENTENCES.selfSend);
  // @solana/spl-token's getAssociatedTokenAddressSync refuses an off-curve
  // owner by default (TokenOwnerOffCurveError) for the same reason.
  if (!isOnCurve(recipientBytes)) throw new SplTokenRefusal('off-curve', SPL_QUOTE_SENTENCES.offCurve);
  const recipientAccount = await client.getAccountInfoBase64(recipient);
  if (recipientAccount !== null && tokenProgramKind(base58.decode(recipientAccount.owner)) !== null) {
    throw new SplTokenRefusal('recipient-token-account', SPL_QUOTE_SENTENCES.recipientIsTokenAccount);
  }

  const programId = tokenProgramId(program);
  const ownerBytes = base58.decode(owner);
  const mintBytes = base58.decode(mint);
  const sourceAta = base58.encode(
    findAssociatedTokenAddress({ owner: ownerBytes, mint: mintBytes, tokenProgramId: programId }).address,
  );
  const destinationAta = base58.encode(
    findAssociatedTokenAddress({ owner: recipientBytes, mint: mintBytes, tokenProgramId: programId }).address,
  );
  const symbol = symbolFor(profile);

  const sourceRaw = await client.getAccountInfoBase64(sourceAta);
  if (sourceRaw === null || !bytesEqual(base58.decode(sourceRaw.owner), programId)) {
    throw new SplTokenRefusal('no-source', SPL_QUOTE_SENTENCES.noSourceAccount(symbol));
  }
  const source = parseTokenAccount(sourceRaw.data, program);
  if (source.mint !== mint || source.owner !== owner) {
    throw new SplTokenRefusal('no-source', SPL_QUOTE_SENTENCES.noSourceAccount(symbol));
  }
  if (source.state === 'frozen') throw new SplTokenRefusal('source-frozen', SPL_QUOTE_SENTENCES.sourceFrozen);
  if (source.amount < amount) {
    throw new SplTokenRefusal(
      'insufficient',
      SPL_QUOTE_SENTENCES.insufficient(
        formatBaseUnits(source.amount, parsed.decimals),
        formatBaseUnits(amount, parsed.decimals),
        symbol,
      ),
    );
  }

  const notes = [...classification.notes];
  const destRaw = await client.getAccountInfoBase64(destinationAta);
  let createsDestination = false;
  let rentLamports = 0n;
  if (destRaw === null) {
    if (classification.defaultAccountState === 'frozen') {
      throw new SplTokenRefusal('destination-default-frozen', SPL_QUOTE_SENTENCES.destinationDefaultFrozen);
    }
    createsDestination = true;
    rentLamports = await client.getMinimumBalanceForRentExemption(associatedAccountLength(parsed));
    notes.push(
      `The recipient does not hold this token yet, so this transaction also creates their token account; you pay its rent of ${rentLamports} lamports, which stays in that account.`,
    );
  } else {
    if (!bytesEqual(base58.decode(destRaw.owner), programId)) {
      throw new SplTokenRefusal('destination-mismatch', SPL_QUOTE_SENTENCES.destinationMismatch);
    }
    const dest = parseTokenAccount(destRaw.data, program);
    if (dest.mint !== mint || dest.owner !== recipient) {
      throw new SplTokenRefusal('destination-mismatch', SPL_QUOTE_SENTENCES.destinationMismatch);
    }
    if (dest.state === 'frozen') {
      throw new SplTokenRefusal('destination-frozen', SPL_QUOTE_SENTENCES.destinationFrozen);
    }
    const memo = findExtension(dest.extensions, EXT.MemoTransfer);
    if (memo && decodeMemoTransfer(memo).requireIncomingTransferMemos) {
      throw new SplTokenRefusal('destination-memo', SPL_QUOTE_SENTENCES.destinationMemo);
    }
    if (findExtension(dest.extensions, EXT.ConfidentialTransferAccount)) {
      throw new SplTokenRefusal('destination-confidential', SPL_QUOTE_SENTENCES.destinationConfidential);
    }
  }

  let transferFee = 0n;
  if (classification.transferClass === 'fee-charging' && classification.transferFee !== null) {
    const epoch = await client.getEpoch();
    const rate = transferFeeRateAt(classification.transferFee, epoch);
    transferFee = calculateTransferFee(rate, amount);
    notes.push(
      rate.basisPoints === 0
        ? SPL_SENTENCES.feeZeroNote
        : SPL_SENTENCES.feeNote(rate.basisPoints, rate.maximumFee.toString()),
    );
  }

  const networkFeeLamports = LAMPORTS_PER_SIGNATURE;
  const lamportsNeeded = networkFeeLamports + rentLamports;
  const held = await client.getBalance(owner);
  if (held < lamportsNeeded) {
    throw new SplTokenRefusal(
      'not-enough-sol',
      SPL_QUOTE_SENTENCES.notEnoughSol(lamportsNeeded.toString(), held.toString(), nativeSymbol ?? 'SOL'),
    );
  }

  const destinationBytes = base58.decode(destinationAta);
  const instructions: SolanaInstruction[] = [];
  if (createsDestination) {
    instructions.push(
      createAssociatedTokenAccountIdempotent({
        payer: ownerBytes,
        owner: recipientBytes,
        mint: mintBytes,
        tokenProgramId: programId,
      }),
    );
  }
  const sourceBytes = base58.decode(sourceAta);
  instructions.push(
    classification.transferClass === 'fee-charging'
      ? transferCheckedWithFee({
          source: sourceBytes,
          mint: mintBytes,
          destination: destinationBytes,
          owner: ownerBytes,
          amount,
          decimals: parsed.decimals,
          fee: transferFee,
        })
      : splTransferChecked({
          source: sourceBytes,
          mint: mintBytes,
          destination: destinationBytes,
          owner: ownerBytes,
          amount,
          decimals: parsed.decimals,
          tokenProgramId: programId,
        }),
  );

  return {
    assetId: solanaTokenAssetId(caip2, mint),
    mint,
    program,
    decimals: parsed.decimals,
    amount,
    transferFee,
    recipientReceives: amount - transferFee,
    sourceAccount: sourceAta,
    destinationAccount: destinationAta,
    createsDestination,
    rentLamports,
    networkFeeLamports,
    instructions,
    notes,
    profile,
  };
}

/** Exact decimal text for base units (no rounding, trailing zeros dropped). */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  if (decimals === 0) return `${negative ? '-' : ''}${abs}`;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}


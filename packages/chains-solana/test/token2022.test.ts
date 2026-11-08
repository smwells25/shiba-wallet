import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { base58, base64 } from '@scure/base';
import { formatAssetId, mnemonicToSeed, solanaKeyProvider } from '@shiba-wallet/core';
import { PublicKey } from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022,
  TOKEN_PROGRAM_ID as SPL_TOKEN,
  calculateFee,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  getAccountLen,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { unpack as unpackTokenMetadata } from '@solana/spl-token-metadata';
import { SolanaRpcClient, type JsonRpcTransport } from '../src/rpc.js';
import {
  createAssociatedTokenAccountIdempotent,
  findAssociatedTokenAddress,
  splTransferChecked,
} from '../src/splToken.js';
import {
  EXT,
  SPL_SENTENCES,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_EXTENSION_NAMES,
  associatedAccountLength,
  calculateTransferFee,
  classifyMint,
  decodeMetaplexMetadata,
  decodeTokenMetadataExtension,
  decodeTransferFeeConfig,
  findExtension,
  parseMint,
  parseTokenAccount,
  sanitizeTokenText,
  transferFeeRateAt,
  type ParsedMint,
} from '../src/tokenExtensions.js';
import {
  KNOWN_SOLANA_TOKENS,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SPL_QUOTE_SENTENCES,
  SPL_UNNAMED_TOKEN,
  SplTokenRefusal,
  findMetaplexMetadataAddress,
  findSolanaLookAlike,
  formatBaseUnits,
  listOwnerTokenAccounts,
  lookAlikeSentence,
  quoteSplTokenTransfer,
  readMintProfile,
  solanaFungibleAsset,
  solanaTokenAssetId,
  transferCheckedWithFee,
} from '../src/tokenTransfer.js';

/**
 * Token-2022 layer tests. Byte layouts are checked against the installed
 * @solana/spl-token 0.4.15 (its unpackers and instruction builders) and
 * against real devnet account data read on 2026-11-07
 * (fixtures/devnet-token-accounts-2026-11-07.json).
 */

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/devnet-token-accounts-2026-11-07.json', import.meta.url), 'utf8'),
) as { accounts: Record<string, { owner: string; lamports: number; dataBase64: string }> };
const USDC_DEV = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PYUSD_DEV = 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM';
const PYUSD_ACCOUNT = '54MgjoGNEbTE3MFH7NVPF2ubSz52nxET6UgSxZ74YLmw';
const fixtureData = (address: string): Uint8Array => base64.decode(FIXTURE.accounts[address]!.dataBase64);
const accountInfo = (address: string) => ({
  data: Buffer.from(fixtureData(address)),
  owner: new PublicKey(FIXTURE.accounts[address]!.owner),
  lamports: FIXTURE.accounts[address]!.lamports,
  executable: false,
});

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const sender = solanaKeyProvider.deriveAccount(seed, 0, 0);
const recipient = solanaKeyProvider.deriveAccount(seed, 1, 0);
const AUTH = base58.encode(new Uint8Array(32).fill(9));
const DELEGATE = base58.encode(new Uint8Array(32).fill(5));

// ---- byte builders for synthetic accounts (layouts from the token-2022 sources) ----
const u16 = (n: number): number[] => [n & 0xff, n >> 8];
const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
const u64 = (n: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const coptionKey = (key: string | null): number[] => (key === null ? new Array(36).fill(0) : [...u32(1), ...base58.decode(key)]);
const tlv = (exts: Array<{ type: number; data: number[] }>): number[] =>
  exts.flatMap((e) => [...u16(e.type), ...u16(e.data.length), ...e.data]);

function mintBytes(opts: {
  decimals?: number;
  supply?: bigint;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  initialized?: boolean;
  extensions?: Array<{ type: number; data: number[] }>;
}): Uint8Array {
  const base = [
    ...coptionKey(opts.mintAuthority ?? AUTH),
    ...u64(opts.supply ?? 1_000_000n),
    opts.decimals ?? 6,
    opts.initialized === false ? 0 : 1,
    ...coptionKey(opts.freezeAuthority ?? null),
  ];
  if (!opts.extensions) return Uint8Array.from(base);
  return Uint8Array.from([...base, ...new Array(165 - 82).fill(0), 1, ...tlv(opts.extensions)]);
}

function tokenAccountBytes(opts: {
  mint: string;
  owner: string;
  amount: bigint;
  state?: number;
  extensions?: Array<{ type: number; data: number[] }>;
}): Uint8Array {
  const base = [
    ...base58.decode(opts.mint),
    ...base58.decode(opts.owner),
    ...u64(opts.amount),
    ...coptionKey(null),
    opts.state ?? 1,
    ...new Array(12).fill(0),
    ...u64(0n),
    ...coptionKey(null),
  ];
  if (!opts.extensions) return Uint8Array.from(base);
  return Uint8Array.from([...base, 2, ...tlv(opts.extensions)]);
}

const feeConfigData = (bps: number, max: bigint, epoch = 0n): number[] => [
  ...base58.decode(AUTH),
  ...base58.decode(AUTH),
  ...u64(0n),
  ...u64(epoch), ...u64(max), ...u16(bps),
  ...u64(epoch), ...u64(max), ...u16(bps),
];
const key = (k: string | null): number[] => (k === null ? new Array(32).fill(0) : [...base58.decode(k)]);
const splInfo = (data: Uint8Array, program = SPL_TOKEN_2022) => ({
  data: Buffer.from(data),
  owner: program,
  lamports: 1,
  executable: false,
});

describe('program ids and extension numbers', () => {
  it('match the installed @solana/spl-token', () => {
    expect(base58.encode(TOKEN_2022_PROGRAM_ID)).toBe(SPL_TOKEN_2022.toBase58());
    // spl-token 0.4.15 has no entry for 16, 17 and 24, and names the Rust
    // ScaledUiAmount and Pausable variants ScaledUiAmountConfig and
    // PausableConfig; every number it has agrees.
    const jsName: Record<string, string> = { ScaledUiAmount: 'ScaledUiAmountConfig', Pausable: 'PausableConfig' };
    let compared = 0;
    for (const [num, name] of Object.entries(TOKEN_EXTENSION_NAMES)) {
      const theirs = (ExtensionType as unknown as Record<string, number | undefined>)[jsName[name] ?? name];
      if (theirs === undefined) continue;
      expect(theirs, name).toBe(Number(num));
      compared++;
    }
    expect(compared).toBe(26);
  });
});

describe('parsing real devnet accounts', () => {
  it('reads the classic devnet USDC mint as spl-token does', () => {
    const ours = parseMint(fixtureData(USDC_DEV), 'spl-token');
    const theirs = unpackMint(new PublicKey(USDC_DEV), accountInfo(USDC_DEV), SPL_TOKEN);
    expect(ours.decimals).toBe(theirs.decimals);
    expect(ours.supply).toBe(theirs.supply);
    expect(ours.mintAuthority).toBe(theirs.mintAuthority?.toBase58() ?? null);
    expect(ours.freezeAuthority).toBe(theirs.freezeAuthority?.toBase58() ?? null);
    expect(ours.extensions).toEqual([]);
    expect(classifyMint(ours).transferClass).toBe('plain');
  });

  it('reads the devnet PYUSD Token-2022 mint and its extensions', () => {
    const data = fixtureData(PYUSD_DEV);
    const ours = parseMint(data, 'token-2022');
    const theirs = unpackMint(new PublicKey(PYUSD_DEV), accountInfo(PYUSD_DEV), SPL_TOKEN_2022);
    expect(ours.decimals).toBe(6);
    expect(ours.supply).toBe(theirs.supply);
    expect(ours.extensions.map((e) => e.type)).toEqual([3, 12, 1, 4, 16, 14, 18, 19]);
    expect(ours.extensions.map((e) => e.type).filter((t) => ![16].includes(t))).toEqual(
      getExtensionTypes(theirs.tlvData).filter((t) => t !== undefined && TOKEN_EXTENSION_NAMES[t] !== undefined && t !== 16),
    );
    const fee = decodeTransferFeeConfig(findExtension(ours.extensions, EXT.TransferFeeConfig)!);
    const theirFee = getTransferFeeConfig(theirs)!;
    expect(fee.newerTransferFee.basisPoints).toBe(theirFee.newerTransferFee.transferFeeBasisPoints);
    expect(fee.newerTransferFee.maximumFee).toBe(theirFee.newerTransferFee.maximumFee);
    expect(fee.newerTransferFee.epoch).toBe(theirFee.newerTransferFee.epoch);
    expect(fee.transferFeeConfigAuthority).toBe(theirFee.transferFeeConfigAuthority.toBase58());
    // The hook program id is all zeros on devnet PYUSD: not set.
    expect(getTransferHook(theirs)!.programId.toBase58()).toBe('11111111111111111111111111111111');
    const cls = classifyMint(ours);
    expect(cls.transferClass).toBe('fee-charging');
    expect(cls.refusal).toBeNull();
    expect(cls.notes).toContain(SPL_SENTENCES.permanentDelegate(getPermanentDelegate(theirs)!.delegate.toBase58()));
    expect(cls.notes).toContain(SPL_SENTENCES.hookUnset);
    expect(cls.notes).toContain(SPL_SENTENCES.mintCloseAuthority);
    expect(cls.notes).toContain(SPL_SENTENCES.confidential);
    // Metadata: our Borsh read equals @solana/spl-token-metadata's unpack.
    const meta = decodeTokenMetadataExtension(findExtension(ours.extensions, EXT.TokenMetadata)!);
    const theirMeta = unpackTokenMetadata(findExtension(ours.extensions, EXT.TokenMetadata)!.data);
    expect(meta.mint).toBe(PYUSD_DEV);
    expect(meta.name).toBe(theirMeta.name);
    expect(meta.symbol).toBe(theirMeta.symbol);
    expect(meta.uri).toBe(theirMeta.uri);
  });

  it('reads a real devnet PYUSD token account, and sizes a new one exactly', () => {
    const data = fixtureData(PYUSD_ACCOUNT);
    const ours = parseTokenAccount(data, 'token-2022');
    const theirs = unpackAccount(new PublicKey(PYUSD_ACCOUNT), accountInfo(PYUSD_ACCOUNT), SPL_TOKEN_2022);
    expect(ours.mint).toBe(theirs.mint.toBase58());
    expect(ours.owner).toBe(theirs.owner.toBase58());
    expect(ours.amount).toBe(theirs.amount);
    expect(ours.state).toBe(theirs.isFrozen ? 'frozen' : 'initialized');
    expect(ours.extensions.map((e) => e.type)).toEqual([EXT.ImmutableOwner, EXT.TransferFeeAmount, EXT.TransferHookAccount]);
    // The real account is 187 bytes, and so is the account the ATA program would create.
    expect(data.length).toBe(187);
    expect(associatedAccountLength(parseMint(fixtureData(PYUSD_DEV), 'token-2022'))).toBe(187);
  });
});

describe('associated account length', () => {
  it('equals spl-token getAccountLen for the extensions it knows', () => {
    const cases: Array<{ mintExt: number[]; accountExt: ExtensionType[] }> = [
      { mintExt: [], accountExt: [ExtensionType.ImmutableOwner] },
      { mintExt: [EXT.TransferFeeConfig], accountExt: [ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount] },
      { mintExt: [EXT.Pausable, EXT.TransferHook], accountExt: [ExtensionType.ImmutableOwner, ExtensionType.PausableAccount, ExtensionType.TransferHookAccount] },
      { mintExt: [EXT.NonTransferable], accountExt: [ExtensionType.ImmutableOwner, ExtensionType.NonTransferableAccount] },
    ];
    for (const c of cases) {
      const mint: ParsedMint = {
        program: 'token-2022', mintAuthority: null, supply: 0n, decimals: 0, isInitialized: true, freezeAuthority: null,
        extensions: c.mintExt.map((type) => ({ type, name: TOKEN_EXTENSION_NAMES[type]!, data: new Uint8Array() })),
      };
      expect(associatedAccountLength(mint)).toBe(getAccountLen(c.accountExt));
    }
    expect(associatedAccountLength({ ...parseMint(fixtureData(USDC_DEV), 'spl-token') })).toBe(165);
  });
});

describe('classifyMint', () => {
  const classify = (extensions: Array<{ type: number; data: number[] }>, freeze: string | null = null) =>
    classifyMint(parseMint(mintBytes({ extensions, freezeAuthority: freeze }), 'token-2022'));

  it('refuses each unsafe class with its exact sentence', () => {
    expect(classify([{ type: EXT.NonTransferable, data: [] }])).toMatchObject({
      transferClass: 'non-transferable',
      refusal: 'This token is non-transferable: its issuer made it impossible to move to another account, so it cannot be sent.',
    });
    const hookProgram = base58.encode(new Uint8Array(32).fill(7));
    expect(classify([{ type: EXT.TransferHook, data: [...key(AUTH), ...key(hookProgram)] }])).toMatchObject({
      transferClass: 'hook-bearing',
      refusal: `This token runs the issuer's program ${hookProgram} on every transfer (a transfer hook). This wallet does not call programs it does not know, so it does not send this token.`,
    });
    expect(classify([{ type: EXT.Pausable, data: [...key(AUTH), 1] }])).toMatchObject({
      transferClass: 'paused',
      refusal: 'The issuer has paused this token, so transfers are refused until the issuer resumes it.',
    });
    expect(classify([{ type: EXT.InterestBearingConfig, data: new Array(52).fill(0) }]).refusal).toBe(
      'This token uses the InterestBearingConfig extension, which changes the amount people are meant to see from the amount actually stored. This wallet does not compute that adjusted amount yet, so it does not send this token rather than show a misleading figure.',
    );
    expect(classify([{ type: EXT.ScaledUiAmount, data: new Array(56).fill(0) }]).transferClass).toBe('display-adjusted');
    expect(classify([{ type: 99, data: [1, 2] }])).toMatchObject({
      transferClass: 'unknown-extension',
      refusal: 'This token uses Token-2022 extension number 99, which this wallet does not know. It does not send a token whose behaviour it cannot describe.',
    });
    expect(classifyMint(parseMint(mintBytes({ initialized: false }), 'spl-token')).refusal).toBe(
      'This address is not an initialized token mint, so nothing can be sent with it.',
    );
  });

  it('applies the refusals in a fixed order', () => {
    expect(classify([{ type: EXT.Pausable, data: [...key(AUTH), 1] }, { type: EXT.NonTransferable, data: [] }]).transferClass).toBe('non-transferable');
    expect(classify([{ type: EXT.NonTransferable, data: [] }, { type: 99, data: [] }]).transferClass).toBe('unknown-extension');
  });

  it('lets plain and fee mints through with their notes', () => {
    const unpaused = classify([{ type: EXT.Pausable, data: [...key(AUTH), 0] }], AUTH);
    expect(unpaused.transferClass).toBe('plain');
    expect(unpaused.notes).toEqual([SPL_SENTENCES.pausable, SPL_SENTENCES.freezeAuthority(AUTH)]);
    const unsetHook = classify([{ type: EXT.TransferHook, data: [...key(AUTH), ...key(null)] }]);
    expect(unsetHook.transferClass).toBe('plain');
    const fee = classify([{ type: EXT.TransferFeeConfig, data: feeConfigData(50, 1_000n) }]);
    expect(fee.transferClass).toBe('fee-charging');
    expect(fee.transferFee!.newerTransferFee.basisPoints).toBe(50);
    const frozen = classify([{ type: EXT.DefaultAccountState, data: [2] }]);
    expect(frozen.defaultAccountState).toBe('frozen');
    expect(frozen.notes).toContain(SPL_SENTENCES.defaultFrozen);
    const delegate = classify([{ type: EXT.PermanentDelegate, data: key(DELEGATE) }]);
    expect(delegate.notes).toEqual([
      `The issuer's permanent delegate ${DELEGATE} can move or burn this token from any account, including yours, at any time; you cannot revoke it.`,
    ]);
  });

  it('agrees with spl-token on synthetic extension data', () => {
    const data = mintBytes({ extensions: [
      { type: EXT.TransferFeeConfig, data: feeConfigData(25, 77n, 3n) },
      { type: EXT.PermanentDelegate, data: key(DELEGATE) },
    ] });
    const theirs = unpackMint(new PublicKey(PYUSD_DEV), splInfo(data), SPL_TOKEN_2022);
    expect(getExtensionTypes(theirs.tlvData)).toEqual([ExtensionType.TransferFeeConfig, ExtensionType.PermanentDelegate]);
    expect(getPermanentDelegate(theirs)!.delegate.toBase58()).toBe(DELEGATE);
    const ours = decodeTransferFeeConfig(findExtension(parseMint(data, 'token-2022').extensions, EXT.TransferFeeConfig)!);
    expect(ours.olderTransferFee).toEqual({ epoch: 3n, maximumFee: 77n, basisPoints: 25 });
  });
});

describe('malformed data is refused', () => {
  it('rejects bad padding, a wrong account type, an overlong entry and the multisig size', () => {
    const good = mintBytes({ extensions: [{ type: EXT.NonTransferable, data: [] }] });
    const badPad = good.slice(); badPad[100] = 1;
    expect(() => parseMint(badPad, 'token-2022')).toThrow('padding is not zero');
    const badType = good.slice(); badType[165] = 2;
    expect(() => parseMint(badType, 'token-2022')).toThrow('account type byte');
    const overlong = Uint8Array.from([...good.slice(0, 166), ...u16(EXT.TransferFeeConfig), ...u16(200), 1]);
    expect(() => parseMint(overlong, 'token-2022')).toThrow('runs past');
    expect(() => parseMint(new Uint8Array(355), 'token-2022')).toThrow('multisig');
    expect(() => parseMint(good, 'spl-token')).toThrow('exactly 82 bytes');
    const accountExtOnMint = mintBytes({ extensions: [{ type: EXT.MemoTransfer, data: [1] }] });
    expect(() => parseMint(accountExtOnMint, 'token-2022')).toThrow('account extension MemoTransfer');
  });
});

describe('transfer fee arithmetic', () => {
  it('equals spl-token calculateFee over many amounts and rates', () => {
    let x = 12345n;
    const rnd = (): bigint => { x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return x; };
    for (let i = 0; i < 2000; i++) {
      const bps = Number(rnd() % 10_001n);
      const max = rnd() % (i % 3 === 0 ? 1000n : 1n << 40n);
      const amount = rnd() % (1n << 50n);
      const ours = calculateTransferFee({ epoch: 0n, basisPoints: bps, maximumFee: max }, amount);
      const theirs = calculateFee({ epoch: 0n, transferFeeBasisPoints: bps, maximumFee: max }, amount);
      expect(ours).toBe(theirs);
    }
  });

  it('picks the newer rate from its epoch on', () => {
    const config = decodeTransferFeeConfig({ type: 1, name: 'TransferFeeConfig', data: Uint8Array.from([
      ...key(AUTH), ...key(AUTH), ...u64(0n), ...u64(0n), ...u64(5n), ...u16(10), ...u64(100n), ...u64(9n), ...u16(20),
    ]) });
    expect(transferFeeRateAt(config, 99n).basisPoints).toBe(10);
    expect(transferFeeRateAt(config, 100n).basisPoints).toBe(20);
  });
});

describe('instruction bytes', () => {
  const mint = new PublicKey(PYUSD_DEV);
  const src = new PublicKey(base58.encode(new Uint8Array(32).fill(1)));
  const dst = new PublicKey(base58.encode(new Uint8Array(32).fill(2)));
  const owner = new PublicKey(sender.publicKey);

  it('TransferCheckedWithFee equals spl-token createTransferCheckedWithFeeInstruction', () => {
    const ours = transferCheckedWithFee({ source: src.toBytes(), mint: mint.toBytes(), destination: dst.toBytes(), owner: owner.toBytes(), amount: 1_234_567n, decimals: 6, fee: 617n });
    const theirs = createTransferCheckedWithFeeInstruction(src, mint, dst, owner, 1_234_567n, 6, 617n);
    expect(ours.data).toEqual(Uint8Array.from(theirs.data));
    expect(ours.data.length).toBe(19);
    expect(base58.encode(ours.programId)).toBe(theirs.programId.toBase58());
    expect(ours.keys.map((k) => [base58.encode(k.pubkey), k.isSigner, k.isWritable])).toEqual(
      theirs.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    );
  });

  it('TransferChecked, the ATA and its idempotent creation match spl-token for Token-2022', () => {
    const ours = splTransferChecked({ source: src.toBytes(), mint: mint.toBytes(), destination: dst.toBytes(), owner: owner.toBytes(), amount: 5n, decimals: 6, tokenProgramId: TOKEN_2022_PROGRAM_ID });
    const theirs = createTransferCheckedInstruction(src, mint, dst, owner, 5n, 6, [], SPL_TOKEN_2022);
    expect(ours.data).toEqual(Uint8Array.from(theirs.data));
    expect(base58.encode(ours.programId)).toBe(SPL_TOKEN_2022.toBase58());
    const ata = findAssociatedTokenAddress({ owner: recipient.publicKey, mint: mint.toBytes(), tokenProgramId: TOKEN_2022_PROGRAM_ID });
    const theirAta = getAssociatedTokenAddressSync(mint, new PublicKey(recipient.publicKey), false, SPL_TOKEN_2022);
    expect(base58.encode(ata.address)).toBe(theirAta.toBase58());
    const create = createAssociatedTokenAccountIdempotent({ payer: owner.toBytes(), owner: recipient.publicKey, mint: mint.toBytes(), tokenProgramId: TOKEN_2022_PROGRAM_ID });
    const theirCreate = createAssociatedTokenAccountIdempotentInstruction(owner, theirAta, new PublicKey(recipient.publicKey), mint, SPL_TOKEN_2022);
    expect(create.keys.map((k) => base58.encode(k.pubkey))).toEqual(theirCreate.keys.map((k) => k.pubkey.toBase58()));
    expect(create.data).toEqual(Uint8Array.from(theirCreate.data));
  });

  it('derives the Metaplex metadata address as web3.js does', () => {
    const META = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    const [theirs] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), META.toBuffer(), mint.toBuffer()], META);
    expect(base58.encode(findMetaplexMetadataAddress(mint.toBytes()))).toBe(theirs.toBase58());
  });
});

describe('metadata text', () => {
  const borsh = (s: string, pad = 0): number[] => {
    const bytes = [...new TextEncoder().encode(s), ...new Array(pad).fill(0)];
    return [...u32(bytes.length), ...bytes];
  };
  it('reads a Metaplex record, dropping its NUL padding', () => {
    const record = Uint8Array.from([4, ...key(AUTH), ...key(PYUSD_DEV), ...borsh('Fake Coin', 23), ...borsh('USDC', 6), ...borsh('https://x', 191), 0, 0]);
    expect(decodeMetaplexMetadata(record)).toEqual({ mint: PYUSD_DEV, name: 'Fake Coin', symbol: 'USDC', uri: 'https://x', source: 'metaplex' });
    expect(() => decodeMetaplexMetadata(Uint8Array.from([5, ...record.slice(1)]))).toThrow('not a Metaplex');
  });
  it('makes issuer text safe to show', () => {
    expect(sanitizeTokenText('US‮DC\u0000 ', 16)).toBe('USDC');
    expect(sanitizeTokenText('​', 16)).toBeNull();
    expect(sanitizeTokenText('A'.repeat(20), 16)).toBe(`${'A'.repeat(16)}…`);
  });
});

describe('CAIP-19 ids and look-alikes', () => {
  it('builds the namespace document example and core accepts it', () => {
    const id = solanaTokenAssetId(SOLANA_MAINNET_CAIP2, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(formatAssetId(id)).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(formatAssetId(solanaTokenAssetId(SOLANA_DEVNET_CAIP2, PYUSD_DEV))).toBe(
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM',
    );
    expect(formatAssetId(solanaTokenAssetId(SOLANA_MAINNET_CAIP2, 'Fz6LxeUg5qjesYX3BdmtTwyyzBtMxk644XiTqU5W3w9w', 'nft'))).toBe(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/nft:Fz6LxeUg5qjesYX3BdmtTwyyzBtMxk644XiTqU5W3w9w',
    );
    expect(() => solanaTokenAssetId('eip155:1', PYUSD_DEV)).toThrow('not a Solana chain id');
    expect(() => solanaTokenAssetId(SOLANA_DEVNET_CAIP2, 'abc')).toThrow('not a Solana mint');
    expect(solanaFungibleAsset({ caip2: SOLANA_DEVNET_CAIP2, mint: USDC_DEV, symbol: 'USDC', name: 'USD Coin', decimals: 6 }).kind).toBe('fungible');
  });
  it('flags a token that borrows a known symbol', () => {
    const fake = base58.encode(new Uint8Array(32).fill(3));
    expect(findSolanaLookAlike(SOLANA_DEVNET_CAIP2, fake, 'usdc')?.mint).toBe(USDC_DEV);
    expect(findSolanaLookAlike(SOLANA_DEVNET_CAIP2, USDC_DEV, 'USDC')).toBeNull();
    expect(findSolanaLookAlike(SOLANA_MAINNET_CAIP2, fake, 'PYUSD')).toBeNull();
    expect(lookAlikeSentence('USDC', USDC_DEV)).toBe(
      `This token calls itself USDC, but it is not the USDC mint this wallet knows (${USDC_DEV}). Anyone can create a token with any name and symbol; only the mint address identifies it.`,
    );
  });
  it('knows Circle\'s EURC on devnet and on mainnet at the one address Circle lists for both', () => {
    // Circle's "EURC contract addresses" page (fetched 2026-11-08) gives
    // HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr in both its "Solana" and
    // its "Solana Devnet" rows; both mints were read on their own cluster the
    // same day: classic SPL Token, 6 decimals (tokenTransfer.ts records the
    // reads). The entries are pinned field by field so a dropped or mistyped
    // entry fails here.
    const EURC = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
    const eurc = KNOWN_SOLANA_TOKENS.filter((t) => t.symbol === 'EURC');
    expect(eurc.map(({ source: _source, ...rest }) => rest)).toEqual([
      { caip2: SOLANA_DEVNET_CAIP2, mint: EURC, symbol: 'EURC', name: 'EURC', decimals: 6, program: 'spl-token' },
      { caip2: SOLANA_MAINNET_CAIP2, mint: EURC, symbol: 'EURC', name: 'EURC', decimals: 6, program: 'spl-token' },
    ]);
    expect(base58.decode(EURC)).toHaveLength(32);
    expect(eurc.every((t) => t.source.startsWith('Circle, EURC contract addresses'))).toBe(true);
    // The earlier entries are unchanged and nothing else was added.
    expect(KNOWN_SOLANA_TOKENS.map((t) => `${t.caip2}/${t.symbol}/${t.mint}`)).toEqual([
      `${SOLANA_DEVNET_CAIP2}/USDC/${USDC_DEV}`,
      `${SOLANA_DEVNET_CAIP2}/PYUSD/${PYUSD_DEV}`,
      `${SOLANA_MAINNET_CAIP2}/USDC/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`,
      `${SOLANA_DEVNET_CAIP2}/EURC/${EURC}`,
      `${SOLANA_MAINNET_CAIP2}/EURC/${EURC}`,
    ]);
    // Another mint calling itself EURC is flagged on either network; the real
    // mint is not, on either network.
    const fake = base58.encode(new Uint8Array(32).fill(4));
    expect(findSolanaLookAlike(SOLANA_DEVNET_CAIP2, fake, 'eurc')).toMatchObject({ caip2: SOLANA_DEVNET_CAIP2, mint: EURC, symbol: 'EURC' });
    expect(findSolanaLookAlike(SOLANA_MAINNET_CAIP2, fake, 'EURC')?.mint).toBe(EURC);
    expect(findSolanaLookAlike(SOLANA_DEVNET_CAIP2, EURC, 'EURC')).toBeNull();
    expect(findSolanaLookAlike(SOLANA_MAINNET_CAIP2, EURC, 'EURC')).toBeNull();
    expect(formatAssetId(solanaTokenAssetId(SOLANA_DEVNET_CAIP2, EURC))).toBe(
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
    );
  });
  it('formats base units exactly', () => {
    expect(formatBaseUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatBaseUnits(1n, 6)).toBe('0.000001');
    expect(formatBaseUnits(7n, 0)).toBe('7');
  });
});

// ---- the quote, against a fake chain ----
type Chain = Map<string, { owner: string; lamports: number; data: Uint8Array }>;
function fakeClient(chain: Chain, opts: { epoch?: number; balance?: bigint; rent?: number } = {}) {
  const calls: string[] = [];
  const transport: JsonRpcTransport = async (method, params) => {
    calls.push(method);
    const value = (address: string) => {
      const a = chain.get(address);
      return a ? { data: [base64.encode(a.data), 'base64'], executable: false, lamports: a.lamports, owner: a.owner } : null;
    };
    switch (method) {
      case 'getAccountInfo': return { context: { slot: 1 }, value: value(params[0] as string) };
      case 'getEpochInfo': return { epoch: opts.epoch ?? 10, absoluteSlot: 1 };
      case 'getMinimumBalanceForRentExemption': return opts.rent ?? 2_039_280;
      case 'getBalance': return { context: { slot: 1 }, value: Number(opts.balance ?? 1_000_000_000n) };
      case 'getTokenAccountsByOwner': {
        const programId = (params[1] as { programId: string }).programId;
        return { context: { slot: 1 }, value: [...chain.entries()].filter(([, a]) => a.owner === programId && a.data.length >= 165)
          .map(([pubkey, a]) => ({ pubkey, account: value(pubkey) })) };
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return { client: new SolanaRpcClient(transport), calls };
}

const T22 = SPL_TOKEN_2022.toBase58();
const CLASSIC = SPL_TOKEN.toBase58();
const MINT = base58.encode(new Uint8Array(32).fill(8));
const ataOf = (owner: Uint8Array, program: Uint8Array) =>
  base58.encode(findAssociatedTokenAddress({ owner, mint: base58.decode(MINT), tokenProgramId: program }).address);

function chainWith(mint: Uint8Array, program: string, extras: Partial<Record<'source' | 'dest', Uint8Array>> = {}): Chain {
  const programBytes = base58.decode(program);
  const chain: Chain = new Map([[MINT, { owner: program, lamports: 1, data: mint }]]);
  chain.set(ataOf(sender.publicKey, programBytes), { owner: program, lamports: 1, data: extras.source ?? tokenAccountBytes({ mint: MINT, owner: sender.address, amount: 5_000_000n, extensions: program === T22 ? [{ type: EXT.ImmutableOwner, data: [] }] : undefined }) });
  if (extras.dest) chain.set(ataOf(recipient.publicKey, programBytes), { owner: program, lamports: 1, data: extras.dest });
  chain.set(sender.address, { owner: '11111111111111111111111111111111', lamports: 1, data: new Uint8Array() });
  return chain;
}
const quote = (client: SolanaRpcClient, amount = 1_000_000n, to = recipient.address) =>
  quoteSplTokenTransfer(client, { caip2: SOLANA_DEVNET_CAIP2, owner: sender.address, recipient: to, mint: MINT, amount });
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e) { if (e instanceof SplTokenRefusal) return { code: e.code, message: e.message }; throw e; }
  throw new Error('expected a refusal');
}

describe('quoteSplTokenTransfer', () => {
  it('quotes a classic transfer that creates the recipient account, matching spl-token', async () => {
    const { client } = fakeClient(chainWith(mintBytes({ mintAuthority: null }), CLASSIC));
    const q = await quote(client);
    expect(q.program).toBe('spl-token');
    expect(q.createsDestination).toBe(true);
    expect(q.rentLamports).toBe(2_039_280n);
    expect(q.transferFee).toBe(0n);
    expect(q.recipientReceives).toBe(1_000_000n);
    expect(q.instructions).toHaveLength(2);
    const theirs = createTransferCheckedInstruction(new PublicKey(q.sourceAccount), new PublicKey(MINT), new PublicKey(q.destinationAccount), new PublicKey(sender.publicKey), 1_000_000n, 6);
    expect(q.instructions[1]!.data).toEqual(Uint8Array.from(theirs.data));
    expect(q.notes).toContain('The recipient does not hold this token yet, so this transaction also creates their token account; you pay its rent of 2039280 lamports, which stays in that account.');
    expect(formatAssetId(q.assetId)).toBe(`${SOLANA_DEVNET_CAIP2}/token:${MINT}`);
  });

  it('asks the rent for the Token-2022 account size the mint needs', async () => {
    const mint = mintBytes({ extensions: [{ type: EXT.TransferFeeConfig, data: feeConfigData(100, 3_000n) }] });
    const sizes: unknown[] = [];
    const { client } = fakeClient(chainWith(mint, T22));
    const orig = client.getMinimumBalanceForRentExemption.bind(client);
    client.getMinimumBalanceForRentExemption = async (n: number) => { sizes.push(n); return orig(n); };
    const q = await quote(client, 1_000_000n);
    expect(sizes).toEqual([182]);
    // 1% of 1,000,000 is 10,000, capped at the 3,000 maximum.
    expect(q.transferFee).toBe(3_000n);
    expect(q.recipientReceives).toBe(997_000n);
    const theirs = createTransferCheckedWithFeeInstruction(new PublicKey(q.sourceAccount), new PublicKey(MINT), new PublicKey(q.destinationAccount), new PublicKey(sender.publicKey), 1_000_000n, 6, 3_000n);
    expect(q.instructions[1]!.data).toEqual(Uint8Array.from(theirs.data));
    expect(q.notes).toContain(SPL_SENTENCES.feeNote(100, '3000'));
  });

  it('refuses each unsafe case with its sentence', async () => {
    const hook = base58.encode(new Uint8Array(32).fill(7));
    const hookMint = mintBytes({ extensions: [{ type: EXT.TransferHook, data: [...key(AUTH), ...key(hook)] }] });
    expect((await refusal(quote(fakeClient(chainWith(hookMint, T22)).client))).code).toBe('hook-bearing');

    const plain = mintBytes({});
    expect(await refusal(quote(fakeClient(chainWith(plain, CLASSIC)).client, 9_000_000n))).toEqual({
      code: 'insufficient', message: 'Not enough of this token: the account holds 5 and this transfer needs 9.',
    });
    expect((await refusal(quote(fakeClient(chainWith(plain, CLASSIC)).client, 1n, sender.address))).message).toBe(SPL_QUOTE_SENTENCES.selfSend);
    expect((await refusal(quote(fakeClient(chainWith(plain, CLASSIC)).client, 0n))).message).toBe('Enter an amount greater than zero.');

    const offCurve = base58.encode(findAssociatedTokenAddress({ owner: sender.publicKey, mint: base58.decode(MINT) }).address);
    expect((await refusal(quote(fakeClient(chainWith(plain, CLASSIC)).client, 1n, offCurve))).code).toBe('off-curve');

    const tokenAccountChain = chainWith(plain, CLASSIC);
    const third = solanaKeyProvider.deriveAccount(seed, 2, 0);
    tokenAccountChain.set(third.address, { owner: CLASSIC, lamports: 1, data: tokenAccountBytes({ mint: MINT, owner: sender.address, amount: 0n }) });
    expect(await refusal(quote(fakeClient(tokenAccountChain).client, 1n, third.address))).toEqual({
      code: 'recipient-token-account',
      message: 'The recipient address is itself a token account, not a wallet. Sending to it would put the tokens in an account that belongs to whoever owns that token account; ask the recipient for their wallet address.',
    });

    const noSource = chainWith(plain, CLASSIC);
    noSource.delete(ataOf(sender.publicKey, SPL_TOKEN.toBytes()));
    expect(await refusal(quote(fakeClient(noSource).client))).toEqual({
      code: 'no-source', message: 'This account holds none of this token in its associated token account, so there is nothing to send.',
    });
    const frozenSource = chainWith(plain, CLASSIC, { source: tokenAccountBytes({ mint: MINT, owner: sender.address, amount: 5_000_000n, state: 2 }) });
    expect((await refusal(quote(fakeClient(frozenSource).client))).code).toBe('source-frozen');

    const memoDest = chainWith(mintBytes({ extensions: [] }), T22, { dest: tokenAccountBytes({ mint: MINT, owner: recipient.address, amount: 0n, extensions: [{ type: EXT.MemoTransfer, data: [1] }] }) });
    expect(await refusal(quote(fakeClient(memoDest).client))).toEqual({
      code: 'destination-memo', message: "The recipient's token account requires a memo with every incoming transfer, and this wallet does not add memos yet.",
    });
    const confDest = chainWith(mintBytes({ extensions: [] }), T22, { dest: tokenAccountBytes({ mint: MINT, owner: recipient.address, amount: 0n, extensions: [{ type: EXT.ConfidentialTransferAccount, data: [0] }] }) });
    expect((await refusal(quote(fakeClient(confDest).client))).code).toBe('destination-confidential');
    const frozenDest = chainWith(plain, CLASSIC, { dest: tokenAccountBytes({ mint: MINT, owner: recipient.address, amount: 0n, state: 2 }) });
    expect((await refusal(quote(fakeClient(frozenDest).client))).code).toBe('destination-frozen');
    const otherOwnerDest = chainWith(plain, CLASSIC, { dest: tokenAccountBytes({ mint: MINT, owner: sender.address, amount: 0n }) });
    expect((await refusal(quote(fakeClient(otherOwnerDest).client))).code).toBe('destination-mismatch');

    const defaultFrozen = mintBytes({ extensions: [{ type: EXT.DefaultAccountState, data: [2] }] });
    expect((await refusal(quote(fakeClient(chainWith(defaultFrozen, T22)).client))).message).toBe(
      'The recipient does not hold this token yet, and new accounts for it start frozen, so the transfer would fail. Nothing was sent.',
    );
    expect(await refusal(quote(fakeClient(chainWith(plain, CLASSIC), { balance: 100n }).client))).toEqual({
      code: 'not-enough-sol',
      message: 'Not enough SOL for this transfer: it needs 2044280 lamports for the network fee and any new account\'s rent, and the account holds 100 lamports.',
    });
    const notToken = new Map([[MINT, { owner: '11111111111111111111111111111111', lamports: 1, data: plain }]]) as Chain;
    expect((await refusal(quote(fakeClient(notToken).client))).code).toBe('not-token-program');
    expect((await refusal(quote(fakeClient(new Map()).client))).message).toBe('No account exists at this mint address on this network.');
    expect((await refusal(quoteSplTokenTransfer(fakeClient(chainWith(plain, CLASSIC)).client, {
      caip2: SOLANA_DEVNET_CAIP2, owner: sender.address, recipient: recipient.address, mint: MINT, amount: 1n, expectedDecimals: 9,
    }))).code).toBe('decimals-changed');
  });

  it('reads no epoch for a plain mint and skips creation when the account exists', async () => {
    const dest = tokenAccountBytes({ mint: MINT, owner: recipient.address, amount: 0n });
    const { client, calls } = fakeClient(chainWith(mintBytes({}), CLASSIC, { dest }));
    const q = await quote(client);
    expect(q.createsDestination).toBe(false);
    expect(q.instructions).toHaveLength(1);
    expect(calls).not.toContain('getEpochInfo');
    expect(calls).not.toContain('getMinimumBalanceForRentExemption');
  });

  it('names the token in the no-source refusal: "holds no DOG", and "none of this token" only without a symbol', async () => {
    expect(SPL_UNNAMED_TOKEN).toBe('this token');
    expect(SPL_QUOTE_SENTENCES.noSourceAccount('PYUSD')).toBe(
      'This account holds no PYUSD in its associated token account, so there is nothing to send.',
    );
    expect(SPL_QUOTE_SENTENCES.noSourceAccount(SPL_UNNAMED_TOKEN)).toBe(
      'This account holds none of this token in its associated token account, so there is nothing to send.',
    );
    // Through the quote, with the symbol read from the mint's own metadata.
    const borsh = (s: string): number[] => [...u32(s.length), ...new TextEncoder().encode(s)];
    const named = mintBytes({ extensions: [{ type: EXT.MetadataPointer, data: [...key(AUTH), ...key(MINT)] }, { type: EXT.TokenMetadata, data: [...key(AUTH), ...key(MINT), ...borsh('Dog Coin'), ...borsh('DOG'), ...borsh(''), ...u32(0)] }] });
    const noSource = chainWith(named, T22);
    noSource.delete(ataOf(sender.publicKey, SPL_TOKEN_2022.toBytes()));
    expect(await refusal(quote(fakeClient(noSource).client))).toEqual({
      code: 'no-source', message: 'This account holds no DOG in its associated token account, so there is nothing to send.',
    });
  });

  it('reads the mint metadata from the Token-2022 extension and ignores a record naming another mint', async () => {
    const borsh = (s: string): number[] => [...u32(s.length), ...new TextEncoder().encode(s)];
    const metaFor = (m: string) => [...key(AUTH), ...key(m), ...borsh('Dog Coin'), ...borsh('DOG'), ...borsh(''), ...u32(0)];
    const own = mintBytes({ extensions: [{ type: EXT.MetadataPointer, data: [...key(AUTH), ...key(MINT)] }, { type: EXT.TokenMetadata, data: metaFor(MINT) }] });
    const profile = await readMintProfile(fakeClient(chainWith(own, T22)).client, MINT);
    expect(profile.metadata).toEqual({ name: 'Dog Coin', symbol: 'DOG', source: 'token-2022-extension' });
    const spoof = mintBytes({ extensions: [{ type: EXT.MetadataPointer, data: [...key(AUTH), ...key(MINT)] }, { type: EXT.TokenMetadata, data: metaFor(USDC_DEV) }] });
    const spoofed = await readMintProfile(fakeClient(chainWith(spoof, T22)).client, MINT);
    expect(spoofed.metadata).toBeNull();
    expect(spoofed.metadataNote).toBe('The metadata record names a different mint, so it is ignored.');
    const elsewhere = mintBytes({ extensions: [{ type: EXT.MetadataPointer, data: [...key(AUTH), ...key(DELEGATE)] }] });
    expect((await readMintProfile(fakeClient(chainWith(elsewhere, T22)).client, MINT)).metadataNote).toBe(
      `The mint points to metadata held in another account (${DELEGATE}), which this wallet does not read yet.`,
    );
    expect((await readMintProfile(fakeClient(chainWith(mintBytes({}), CLASSIC)).client, MINT)).metadataNote).toBe(
      'No on-chain name or symbol was found for this mint.',
    );
  });
});

describe('listOwnerTokenAccounts', () => {
  it('lists both programs, marks associated accounts and skips foreign entries', async () => {
    const chain = chainWith(mintBytes({}), CLASSIC);
    const t22Ata = base58.encode(findAssociatedTokenAddress({ owner: sender.publicKey, mint: base58.decode(PYUSD_DEV), tokenProgramId: TOKEN_2022_PROGRAM_ID }).address);
    chain.set(t22Ata, { owner: T22, lamports: 1, data: tokenAccountBytes({ mint: PYUSD_DEV, owner: sender.address, amount: 42n, extensions: [{ type: EXT.ImmutableOwner, data: [] }] }) });
    chain.set(base58.encode(new Uint8Array(32).fill(4)), { owner: T22, lamports: 1, data: tokenAccountBytes({ mint: PYUSD_DEV, owner: recipient.address, amount: 1n }) });
    const { client, calls } = fakeClient(chain);
    const listed = await listOwnerTokenAccounts(client, sender.address);
    expect(calls).toEqual(['getTokenAccountsByOwner', 'getTokenAccountsByOwner']);
    expect(listed.skipped).toBe(1);
    expect(listed.accounts.map((a) => [a.program, a.account.mint, a.account.amount, a.isAssociated])).toEqual([
      ['spl-token', MINT, 5_000_000n, true],
      ['token-2022', PYUSD_DEV, 42n, true],
    ]);
  });
});

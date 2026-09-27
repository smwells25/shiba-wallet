import { describe, expect, it } from 'vitest';
import { base58 } from '@scure/base';
import {
  mnemonicToSeed,
  slip10DerivePath,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { compileMessage, serializeMessage } from '../src/message.js';
import { createProgramAddress, findProgramAddress, isOnCurve } from '../src/pda.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildSplTransfer,
  createAssociatedTokenAccountIdempotent,
  findAssociatedTokenAddress,
} from '../src/splToken.js';
import { signTransaction } from '../src/transaction.js';

/**
 * Cross-checks against the installed @solana/web3.js 1.99.0 and
 * @solana/spl-token 0.4.15: PDA and ATA derivations must match exactly, and
 * a full TransferChecked transaction (same keys, same blockhash, same
 * amount) built with both stacks must produce identical serialized message
 * bytes and, because ed25519 signing is deterministic (RFC 8032), identical
 * signatures.
 *
 * Note on fixtures: our message compiler sorts keys within a privilege
 * class by base58 code-point order, while web3.js uses localeCompare with
 * the "en" locale (see the compileMessage doc comment in src/message.ts).
 * The two orderings agree for the specific keys these fixtures derive, and
 * the byte-equality assertions below would fail loudly if a fixture change
 * ever broke that agreement.
 */

// Standard BIP-39 test mnemonic; same one the core test suite uses.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(MNEMONIC);

const sender = solanaKeyProvider.deriveAccount(seed, 0, 0);
const recipient = solanaKeyProvider.deriveAccount(seed, 1, 0);
const thirdWallet = solanaKeyProvider.deriveAccount(seed, 2, 0);

// The mainnet USDC mint: a real, well-known mint so the fixture is
// meaningful, though derivation only needs any 32-byte key.
const USDC_MINT = base58.decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
// A second, arbitrary but fixed mint for more derivation coverage.
const OTHER_MINT = base58.decode('So11111111111111111111111111111111111111112');

const BLOCKHASH = base58.encode(new Uint8Array(32).fill(7));
const AMOUNT = 2_500_000n; // 2.5 USDC at 6 decimals
const DECIMALS = 6;

describe('program ids', () => {
  it('match the installed @solana/spl-token constants', () => {
    expect(base58.encode(TOKEN_PROGRAM_ID)).toBe(SPL_TOKEN_PROGRAM_ID.toBase58());
    expect(base58.encode(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(
      SPL_ATA_PROGRAM_ID.toBase58(),
    );
  });
});

describe('PDA derivation', () => {
  it('matches web3.js findProgramAddressSync for assorted seed sets', () => {
    const seedSets: Uint8Array[][] = [
      [new TextEncoder().encode('vault')],
      [sender.publicKey, USDC_MINT],
      [new TextEncoder().encode('metadata'), OTHER_MINT, recipient.publicKey],
      [Uint8Array.of()], // empty seed is legal
    ];
    for (const seeds of seedSets) {
      const ours = findProgramAddress(seeds, TOKEN_PROGRAM_ID);
      const [theirAddress, theirBump] = PublicKey.findProgramAddressSync(
        seeds.map((s) => Buffer.from(s)),
        SPL_TOKEN_PROGRAM_ID,
      );
      expect(base58.encode(ours.address)).toBe(theirAddress.toBase58());
      expect(ours.bump).toBe(theirBump);
      // A PDA is by construction not a valid ed25519 public key.
      expect(isOnCurve(ours.address)).toBe(false);
    }
  });

  it('matches web3.js createProgramAddressSync for an explicit bump', () => {
    const seeds = [new TextEncoder().encode('vault')];
    const { bump } = findProgramAddress(seeds, TOKEN_PROGRAM_ID);
    const ours = createProgramAddress(
      [...seeds, Uint8Array.of(bump)],
      TOKEN_PROGRAM_ID,
    );
    const theirs = PublicKey.createProgramAddressSync(
      [Buffer.from('vault'), Buffer.from([bump])],
      SPL_TOKEN_PROGRAM_ID,
    );
    expect(base58.encode(ours)).toBe(theirs.toBase58());
  });

  it('agrees with web3.js on what is on the curve', () => {
    expect(isOnCurve(sender.publicKey)).toBe(true);
    expect(PublicKey.isOnCurve(sender.publicKey)).toBe(true);
    expect(isOnCurve(SYSTEM_PROGRAM_ID_BYTES)).toBe(
      PublicKey.isOnCurve(SYSTEM_PROGRAM_ID_BYTES),
    );
  });

  it('rejects seeds longer than 32 bytes', () => {
    expect(() => findProgramAddress([new Uint8Array(33)], TOKEN_PROGRAM_ID)).toThrow(
      /seed exceeds/,
    );
  });
});

const SYSTEM_PROGRAM_ID_BYTES = base58.decode('11111111111111111111111111111111');

describe('associated token address derivation', () => {
  const cases: Array<{ name: string; owner: Uint8Array; mint: Uint8Array }> = [
    { name: 'sender / USDC', owner: sender.publicKey, mint: USDC_MINT },
    { name: 'recipient / USDC', owner: recipient.publicKey, mint: USDC_MINT },
    { name: 'third wallet / wSOL', owner: thirdWallet.publicKey, mint: OTHER_MINT },
    { name: 'sender / wSOL', owner: sender.publicKey, mint: OTHER_MINT },
  ];

  for (const { name, owner, mint } of cases) {
    it(`matches getAssociatedTokenAddressSync for ${name}`, () => {
      const ours = findAssociatedTokenAddress({ owner, mint });
      const theirs = getAssociatedTokenAddressSync(
        new PublicKey(mint),
        new PublicKey(owner),
      );
      expect(base58.encode(ours.address)).toBe(theirs.toBase58());
    });
  }

  it('matches for an off-curve (PDA) owner', () => {
    // A program-owned vault: its authority is itself a PDA, which is
    // off-curve by construction. spl-token requires allowOwnerOffCurve for
    // this case; our derivation handles it uniformly.
    const { address: pdaOwner } = findProgramAddress(
      [new TextEncoder().encode('vault'), USDC_MINT],
      TOKEN_PROGRAM_ID,
    );
    expect(isOnCurve(pdaOwner)).toBe(false);
    const ours = findAssociatedTokenAddress({ owner: pdaOwner, mint: USDC_MINT });
    const theirs = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      new PublicKey(pdaOwner),
      true, // allowOwnerOffCurve
    );
    expect(base58.encode(ours.address)).toBe(theirs.toBase58());
  });
});

describe('create-ATA idempotent instruction', () => {
  it('is field-identical to spl-token createAssociatedTokenAccountIdempotentInstruction', () => {
    const ours = createAssociatedTokenAccountIdempotent({
      payer: sender.publicKey,
      owner: recipient.publicKey,
      mint: USDC_MINT,
    });
    const theirs = createAssociatedTokenAccountIdempotentInstruction(
      new PublicKey(sender.publicKey), // payer
      getAssociatedTokenAddressSync(
        new PublicKey(USDC_MINT),
        new PublicKey(recipient.publicKey),
      ),
      new PublicKey(recipient.publicKey), // owner
      new PublicKey(USDC_MINT),
    );
    expect(base58.encode(ours.programId)).toBe(theirs.programId.toBase58());
    expect([...ours.data]).toEqual([...new Uint8Array(theirs.data)]);
    expect(ours.data.length).toBe(1);
    expect(ours.data[0]).toBe(1); // CreateIdempotent discriminant
    expect(ours.keys.length).toBe(theirs.keys.length);
    for (let i = 0; i < ours.keys.length; i++) {
      expect(base58.encode(ours.keys[i]!.pubkey)).toBe(theirs.keys[i]!.pubkey.toBase58());
      expect(ours.keys[i]!.isSigner).toBe(theirs.keys[i]!.isSigner);
      expect(ours.keys[i]!.isWritable).toBe(theirs.keys[i]!.isWritable);
    }
  });
});

/** Builds the reference transaction with web3.js + spl-token. */
function buildTheirTransaction(withCreate: boolean): Transaction {
  const owner = new PublicKey(sender.publicKey);
  const dest = new PublicKey(recipient.publicKey);
  const mint = new PublicKey(USDC_MINT);
  const sourceAta = getAssociatedTokenAddressSync(mint, owner);
  const destAta = getAssociatedTokenAddressSync(mint, dest);
  const tx = new Transaction({ recentBlockhash: BLOCKHASH, feePayer: owner });
  if (withCreate) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(owner, destAta, dest, mint),
    );
  }
  tx.add(
    createTransferCheckedInstruction(sourceAta, mint, destAta, owner, AMOUNT, DECIMALS),
  );
  return tx;
}

/** Builds the same message with this package. */
function buildOurMessage(withCreate: boolean) {
  const plan = buildSplTransfer({
    owner: sender.publicKey,
    recipient: recipient.publicKey,
    mint: USDC_MINT,
    amount: AMOUNT,
    decimals: DECIMALS,
    createRecipientAta: withCreate,
  });
  return compileMessage({
    feePayer: sender.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: plan.instructions,
  });
}

describe('TransferChecked cross-check against web3.js + spl-token', () => {
  it('encodes the documented 10-byte data: tag 12 + u64 LE amount + u8 decimals', () => {
    const plan = buildSplTransfer({
      owner: sender.publicKey,
      recipient: recipient.publicKey,
      mint: USDC_MINT,
      amount: AMOUNT,
      decimals: DECIMALS,
    });
    expect(plan.instructions.length).toBe(1);
    const data = plan.instructions[0]!.data;
    expect(data.length).toBe(10);
    expect(data[0]).toBe(12); // TransferChecked discriminant
    // u64 LE 2_500_000 = 0x2625A0
    expect([...data.slice(1, 9)]).toEqual([0xa0, 0x25, 0x26, 0, 0, 0, 0, 0]);
    expect(data[9]).toBe(DECIMALS);
  });

  for (const withCreate of [false, true]) {
    const label = withCreate ? 'create-ATA + transfer' : 'transfer only';

    it(`serializes identical message bytes (${label})`, () => {
      const theirs = new Uint8Array(
        buildTheirTransaction(withCreate).compileMessage().serialize(),
      );
      const ours = serializeMessage(buildOurMessage(withCreate));
      expect([...ours]).toEqual([...theirs]);
    });

    it(`produces identical signatures and wire bytes (${label})`, () => {
      // web3.js needs the raw 32-byte private key, which core's
      // DerivedAccount deliberately does not expose; re-derive it.
      const node = slip10DerivePath(seed, "m/44'/501'/0'/0'");
      const keypair = Keypair.fromSeed(node.privateKey);
      expect(keypair.publicKey.toBase58()).toBe(sender.address);

      const theirTx = buildTheirTransaction(withCreate);
      theirTx.sign(keypair);
      const theirWire = new Uint8Array(theirTx.serialize());
      const theirSignature = new Uint8Array(theirTx.signature!);

      const signed = signTransaction(buildOurMessage(withCreate), [sender]);

      // ed25519 (RFC 8032) is deterministic, so signatures match exactly.
      expect([...signed.signatures[0]!]).toEqual([...theirSignature]);
      expect([...signed.wireBytes]).toEqual([...theirWire]);
    });
  }

  it('derives the same source and destination ATAs the reference uses', () => {
    const plan = buildSplTransfer({
      owner: sender.publicKey,
      recipient: recipient.publicKey,
      mint: USDC_MINT,
      amount: AMOUNT,
      decimals: DECIMALS,
    });
    expect(base58.encode(plan.sourceAta)).toBe(
      getAssociatedTokenAddressSync(
        new PublicKey(USDC_MINT),
        new PublicKey(sender.publicKey),
      ).toBase58(),
    );
    expect(base58.encode(plan.destinationAta)).toBe(
      getAssociatedTokenAddressSync(
        new PublicKey(USDC_MINT),
        new PublicKey(recipient.publicKey),
      ).toBase58(),
    );
  });
});

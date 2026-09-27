import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { concatBytes } from './encoding.js';

/**
 * Program Derived Address (PDA) computation. Pure and offline.
 *
 * The algorithm below was verified on 2026-09-27 against two sources:
 *
 * 1. The official PDA documentation, https://solana.com/docs/core/pda, which
 *    states that a candidate "is verified to not be a valid Ed25519 public
 *    key. If the hash happens to land on the curve, the derivation fails and
 *    a different bump seed is tried", that the bump range is "0-255 (1
 *    byte)" appended "as the final seed element", and that seeds are capped
 *    at 16 with a "32 bytes maximum per seed".
 *
 * 2. The installed @solana/web3.js 1.99.0 reference implementation
 *    (node_modules/@solana/web3.js/lib/index.cjs.js):
 *
 *    - createProgramAddressSync concatenates every seed (each at most
 *      MAX_SEED_LENGTH = 32 bytes), then the 32-byte program id, then the
 *      ASCII string "ProgramDerivedAddress"; hashes the whole buffer with
 *      SHA-256; and throws "Invalid seeds, address must fall off the curve"
 *      when the 32-byte digest decodes as a valid ed25519 curve point.
 *    - findProgramAddressSync starts at nonce 255 and appends the one-byte
 *      nonce as an extra final seed, decrementing on each on-curve failure
 *      with the loop condition `while (nonce != 0)`. Note that this means
 *      bump 0 is never tried: iteration covers 255 down to 1, and the
 *      function throws "Unable to find a viable program address nonce" if
 *      all 255 candidates land on the curve (probability ~2^-255, since
 *      roughly half of all 32-byte strings decode as curve points). This
 *      implementation matches that exact behavior so derived addresses can
 *      never disagree with the ecosystem reference.
 *
 * The on-curve check uses @noble/curves ed25519 Point.fromBytes, which
 * throws for a 32-byte string that does not decode to a point on the curve.
 * web3.js 1.99.0 performs the same check via its bundled noble ExtendedPoint
 * decoder, and the cross-check tests in this package assert equality against
 * @solana/spl-token's derivations for real inputs.
 */

/** Documented per-seed byte cap (web3.js MAX_SEED_LENGTH, docs "32 bytes"). */
export const MAX_SEED_LENGTH = 32;

/** Documented maximum number of seeds (https://solana.com/docs/core/pda). */
export const MAX_SEEDS = 16;

/** The ASCII domain-separator suffix hashed after the program id. */
const PDA_MARKER = utf8ToBytes('ProgramDerivedAddress');

/** Returns true when the 32 bytes decode as a valid ed25519 curve point. */
export function isOnCurve(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return false;
  try {
    ed25519.Point.fromBytes(publicKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes sha256(seeds || programId || "ProgramDerivedAddress") and returns
 * the 32-byte result, throwing when it lands ON the ed25519 curve (a PDA
 * must not have a corresponding private key, which is exactly what being
 * off-curve guarantees).
 */
export function createProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): Uint8Array {
  if (programId.length !== 32) {
    throw new Error('program id must be a 32-byte public key');
  }
  if (seeds.length > MAX_SEEDS) {
    throw new Error(`too many seeds: ${seeds.length} > ${MAX_SEEDS}`);
  }
  for (const seed of seeds) {
    if (seed.length > MAX_SEED_LENGTH) {
      throw new Error(`seed exceeds ${MAX_SEED_LENGTH} bytes`);
    }
  }
  const candidate = sha256(concatBytes(...seeds, programId, PDA_MARKER));
  if (isOnCurve(candidate)) {
    throw new Error('invalid seeds: address must fall off the ed25519 curve');
  }
  return candidate;
}

/**
 * Finds the first valid PDA by appending a one-byte bump seed, starting at
 * 255 and decrementing. Returns the 32-byte address and the bump that
 * produced it. Mirrors web3.js findProgramAddressSync exactly, including
 * never trying bump 0 (see the file comment above).
 */
export function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): { address: Uint8Array; bump: number } {
  for (let bump = 255; bump !== 0; bump--) {
    try {
      const address = createProgramAddress(
        [...seeds, Uint8Array.of(bump)],
        programId,
      );
      return { address, bump };
    } catch (err) {
      // Seed-shape errors are real caller mistakes; only an on-curve
      // candidate means "try the next bump". Same split as web3.js, which
      // rethrows TypeError (seed too long) but continues on curve failures.
      if (err instanceof Error && /off the ed25519 curve/.test(err.message)) {
        continue;
      }
      throw err;
    }
  }
  throw new Error('unable to find a viable program address bump');
}

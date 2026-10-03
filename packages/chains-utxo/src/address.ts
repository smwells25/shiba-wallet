import { sha256 } from '@noble/hashes/sha2.js';
import { base58check, bech32, bech32m } from '@scure/base';
import { BITCOIN_CORE_DUST_POLICY, DOGECOIN_CORE_DUST_POLICY, type DustPolicy } from './dust.js';
import { concatBytes } from './encoding.js';

/**
 * Output-side address handling: decoding a recipient address into the
 * scriptPubKey that locks the output, and the reverse for round-tripping.
 * Every supported script template is spelled out byte by byte below so a
 * reviewer can compare directly against the Bitcoin script wiki / BIPs.
 */

/** Script opcodes used by the standard templates this package supports. */
const OP_0 = 0x00;
const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUAL = 0x87;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;

export interface UtxoNetwork {
  name: string;
  /** bech32 human-readable part for native segwit, absent on Dogecoin. */
  bech32Hrp?: string;
  /** base58check leading version byte for pay-to-pubkey-hash addresses. */
  p2pkhVersion: number;
  /** base58check leading version byte for pay-to-script-hash addresses. */
  p2shVersion: number;
  /**
   * The chain's dust policy (see dust.ts): the smallest output the wallet
   * will create. Optional so that custom network objects keep working;
   * when absent, Bitcoin Core's thresholds (546 / 294) apply.
   */
  dustPolicy?: DustPolicy;
}

/**
 * Bitcoin mainnet. Version bytes 0x00 (P2PKH, "1...") and 0x05 (P2SH, "3...")
 * per bitcoin/bitcoin src/kernel/chainparams.cpp (base58Prefixes
 * PUBKEY_ADDRESS = 1,0 and SCRIPT_ADDRESS = 1,5); additionally cross-checked
 * in tests against bitcoinjs-lib's networks.bitcoin. HRP "bc" per BIP-173.
 */
export const BITCOIN: UtxoNetwork = {
  name: 'Bitcoin',
  bech32Hrp: 'bc',
  p2pkhVersion: 0x00,
  p2shVersion: 0x05,
  dustPolicy: BITCOIN_CORE_DUST_POLICY,
};

/**
 * Dogecoin mainnet. Verified against dogecoin/dogecoin src/chainparams.cpp
 * (mainnet): PUBKEY_ADDRESS = 30 (0x1e, "D..."), SCRIPT_ADDRESS = 22 (0x16),
 * SECRET_KEY (WIF) = 158 (0x9e). Dogecoin has not activated segwit, so there
 * is no bech32 HRP and only legacy address forms exist.
 */
export const DOGECOIN: UtxoNetwork = {
  name: 'Dogecoin',
  p2pkhVersion: 0x1e,
  p2shVersion: 0x16,
  dustPolicy: DOGECOIN_CORE_DUST_POLICY,
};

/** Dogecoin mainnet WIF version byte, from chainparams.cpp as cited above. */
export const DOGECOIN_WIF_VERSION = 0x9e;

/**
 * Bitcoin testnet (testnet3/testnet4) and signet share these parameters:
 * PUBKEY_ADDRESS = 111 (0x6f), SCRIPT_ADDRESS = 196 (0xc4), bech32 HRP
 * "tb", per bitcoin/bitcoin src/kernel/chainparams.cpp (CTestNetParams,
 * CTestNet4Params, SigNetParams). Used by the testnet smoke test.
 */
export const BITCOIN_TESTNET: UtxoNetwork = {
  name: 'Bitcoin testnet',
  bech32Hrp: 'tb',
  p2pkhVersion: 0x6f,
  p2shVersion: 0xc4,
  dustPolicy: BITCOIN_CORE_DUST_POLICY,
};

/**
 * Dogecoin testnet: PUBKEY_ADDRESS = 113 (0x71, "n..."), SCRIPT_ADDRESS =
 * 196 (0xc4), per dogecoin/dogecoin src/chainparams.cpp (CTestNetParams).
 * The dust limits are global policy defaults in Dogecoin Core (not chain
 * parameters), so testnet nodes apply the same ones as mainnet.
 */
export const DOGECOIN_TESTNET: UtxoNetwork = {
  name: 'Dogecoin testnet',
  p2pkhVersion: 0x71,
  p2shVersion: 0xc4,
  dustPolicy: DOGECOIN_CORE_DUST_POLICY,
};

const b58c = base58check(sha256);

/** OP_DUP OP_HASH160 <20-byte pubkey hash> OP_EQUALVERIFY OP_CHECKSIG */
export function p2pkhScript(pubKeyHash: Uint8Array): Uint8Array {
  if (pubKeyHash.length !== 20) throw new Error('p2pkh hash must be 20 bytes');
  return concatBytes(
    new Uint8Array([OP_DUP, OP_HASH160, 20]),
    pubKeyHash,
    new Uint8Array([OP_EQUALVERIFY, OP_CHECKSIG]),
  );
}

/** OP_HASH160 <20-byte script hash> OP_EQUAL */
export function p2shScript(scriptHash: Uint8Array): Uint8Array {
  if (scriptHash.length !== 20) throw new Error('p2sh hash must be 20 bytes');
  return concatBytes(new Uint8Array([OP_HASH160, 20]), scriptHash, new Uint8Array([OP_EQUAL]));
}

/** OP_0 <20-byte pubkey hash> — native segwit v0 pay-to-witness-pubkey-hash. */
export function p2wpkhScript(pubKeyHash: Uint8Array): Uint8Array {
  if (pubKeyHash.length !== 20) throw new Error('p2wpkh hash must be 20 bytes');
  return concatBytes(new Uint8Array([OP_0, 20]), pubKeyHash);
}

/** OP_0 <32-byte script hash> — native segwit v0 pay-to-witness-script-hash. */
export function p2wshScript(scriptHash: Uint8Array): Uint8Array {
  if (scriptHash.length !== 32) throw new Error('p2wsh hash must be 32 bytes');
  return concatBytes(new Uint8Array([OP_0, 32]), scriptHash);
}

/** True when the script is the 22-byte OP_0 PUSH20 P2WPKH template. */
export function isP2wpkhScript(script: Uint8Array): boolean {
  return script.length === 22 && script[0] === OP_0 && script[1] === 20;
}

/** True when the script is the 25-byte P2PKH template. */
export function isP2pkhScript(script: Uint8Array): boolean {
  return (
    script.length === 25 &&
    script[0] === OP_DUP &&
    script[1] === OP_HASH160 &&
    script[2] === 20 &&
    script[23] === OP_EQUALVERIFY &&
    script[24] === OP_CHECKSIG
  );
}

/**
 * Decodes a recipient address into the scriptPubKey to place in the output.
 *
 * Accepted forms:
 * - bech32 segwit v0 (P2WPKH 20-byte and P2WSH 32-byte programs), only on
 *   networks that define an HRP (Bitcoin);
 * - base58check P2PKH and P2SH using the network's version bytes.
 *
 * Everything else is rejected with a specific error, including taproot
 * (bech32m / witness v1), which this wallet does not support yet.
 */
export function addressToScriptPubKey(address: string, network: UtxoNetwork): Uint8Array {
  const lower = address.toLowerCase();

  // A bech32 address always starts with "<hrp>1". BIP-173 forbids mixed
  // case, and @scure/base enforces that during decode.
  if (network.bech32Hrp && lower.startsWith(`${network.bech32Hrp}1`)) {
    return segwitAddressToScript(address, network);
  }
  if (lower.startsWith('bc1') || lower.startsWith('tb1')) {
    throw new Error(`${network.name}: segwit address "${address}" is not valid on this network`);
  }

  let decoded: Uint8Array;
  try {
    decoded = b58c.decode(address);
  } catch {
    throw new Error(`Unrecognized address (not valid bech32 or base58check): ${address}`);
  }
  if (decoded.length !== 21) {
    throw new Error(`Unsupported base58check payload length ${decoded.length} in ${address}`);
  }
  const version = decoded[0]!;
  const hash = decoded.subarray(1);
  if (version === network.p2pkhVersion) return p2pkhScript(hash);
  if (version === network.p2shVersion) return p2shScript(hash);
  throw new Error(
    `${network.name}: unknown base58 version byte 0x${version.toString(16)} in ${address} ` +
      `(expected 0x${network.p2pkhVersion.toString(16)} for P2PKH ` +
      `or 0x${network.p2shVersion.toString(16)} for P2SH)`,
  );
}

function segwitAddressToScript(address: string, network: UtxoNetwork): Uint8Array {
  let words: number[];
  try {
    const decoded = bech32.decode(address as `${string}1${string}`);
    if (decoded.prefix !== network.bech32Hrp) {
      throw new Error(`wrong prefix ${decoded.prefix}`);
    }
    words = [...decoded.words];
  } catch {
    // BIP-350: witness v1+ addresses use the bech32m checksum, so a valid
    // taproot address fails plain bech32 decoding. Distinguish that case to
    // give a precise "not supported yet" error instead of "invalid".
    try {
      const m = bech32m.decode(address as `${string}1${string}`);
      if (m.prefix === network.bech32Hrp && m.words[0] === 1) {
        throw new Error(`Taproot (P2TR) addresses are not supported yet: ${address}`);
      }
      throw new Error(`Unsupported segwit version ${m.words[0]} (bech32m): ${address}`);
    } catch (inner) {
      if (inner instanceof Error && /not supported|Unsupported/.test(inner.message)) throw inner;
      throw new Error(`Invalid bech32 address: ${address}`);
    }
  }

  const version = words[0];
  const program = bech32.fromWords(words.slice(1));
  if (version !== 0) {
    // A v1+ program with a plain bech32 checksum is outright invalid per
    // BIP-350; anything above v1 is a future soft fork we do not know.
    throw new Error(`Segwit v${version} with bech32 checksum is invalid (BIP-350): ${address}`);
  }
  if (program.length === 20) return p2wpkhScript(program);
  if (program.length === 32) return p2wshScript(program);
  throw new Error(`Segwit v0 program must be 20 or 32 bytes, got ${program.length}: ${address}`);
}

/**
 * Encodes a scriptPubKey back into an address on the given network. This is
 * the inverse of addressToScriptPubKey and exists mainly so tests can prove
 * decoding round-trips without loss.
 */
export function scriptPubKeyToAddress(script: Uint8Array, network: UtxoNetwork): string {
  if (isP2pkhScript(script)) {
    return b58c.encode(
      concatBytes(new Uint8Array([network.p2pkhVersion]), script.subarray(3, 23)),
    );
  }
  if (script.length === 23 && script[0] === OP_HASH160 && script[1] === 20 && script[22] === OP_EQUAL) {
    return b58c.encode(concatBytes(new Uint8Array([network.p2shVersion]), script.subarray(2, 22)));
  }
  if (script.length >= 2 && script[0] === OP_0 && (script[1] === 20 || script[1] === 32)) {
    if (!network.bech32Hrp) {
      throw new Error(`${network.name} has no segwit address format`);
    }
    return bech32.encode(network.bech32Hrp, [0, ...bech32.toWords(script.subarray(2))]);
  }
  throw new Error('Unsupported scriptPubKey template');
}

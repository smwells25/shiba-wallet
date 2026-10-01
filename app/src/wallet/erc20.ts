import type { FungibleAsset } from '@shiba-wallet/core';
import {
  decodeUint256,
  encodeErc20BalanceOf,
  encodeFunctionCall,
  httpTransport,
  toBytes,
  toHex,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extension: this module is imported by scripts/check-tokens.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { EVM_CHAIN_ID, validateRecipient, type RecipientValidation } from './send.ts';

/**
 * ERC-20 read-side glue for the app: metadata lookup (symbol/name/decimals)
 * and balanceOf, both as eth_call reads through the engine's injected
 * JSON-RPC transport. All calldata encoding and uint256 decoding comes from
 * @shiba-wallet/chains-evm; the only decoding implemented here is the ABI
 * `string` return type, which the engine does not yet cover (documented
 * below, next to the decoder).
 *
 * Deliberately free of React Native imports so scripts/check-tokens.mjs can
 * exercise the exact code the app runs under plain Node, like balances.ts
 * and send.ts. Tokens are READ-ONLY in this phase: nothing in this module
 * (or the screens using it) signs or sends anything.
 */

/**
 * USDC on Ethereum mainnet — the single token tracked by default.
 *
 * The contract address was verified on 2026-09-27 from two independent
 * public sources plus the chain itself:
 *
 * 1. Circle (the issuer), "USDC contract addresses" documentation page
 *    (https://developers.circle.com/stablecoins/usdc-contract-addresses):
 *    the table row for Ethereum lists exactly
 *    0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48.
 * 2. Etherscan's token page for that address
 *    (https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48):
 *    page title "USDC (USDC) | ERC-20 | Address: 0xA0b86991...E3606eB48",
 *    with ~8.9M holders and a ~$50B on-chain market cap — properties no
 *    impostor contract could show.
 * 3. On chain, via eth_call against https://ethereum-rpc.publicnode.com
 *    (the app's default Ethereum endpoint): symbol() returned the ABI
 *    string "USDC", decimals() returned 6, and name() returned "USD Coin".
 *
 * All three agree, and the checks in (3) are re-run by
 * scripts/check-tokens.mjs so any drift would be caught.
 */
export const USDC_MAINNET: FungibleAsset = {
  kind: 'fungible',
  assetId: {
    chainId: EVM_CHAIN_ID, // 'eip155:1'
    namespace: 'erc20',
    reference: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
};

/**
 * Validates a user-typed ERC-20 contract address, reusing the send flow's
 * EVM recipient validation verbatim (core's toChecksumAddress underneath):
 * all-lowercase/uppercase input is accepted and normalized to the EIP-55
 * checksummed form, mixed-case input must match its checksum exactly.
 * The normalized (checksummed) form is what goes into the CAIP-19 asset id,
 * so the same contract can never be tracked twice under different casings.
 */
export function validateErc20ContractAddress(raw: string): RecipientValidation {
  return validateRecipient(EVM_CHAIN_ID, raw);
}

/**
 * Thrown by decodeAbiString when the return data is a single 32-byte word:
 * the legacy bytes32 metadata convention (a handful of old tokens, e.g.
 * MKR and SAI, declared `bytes32 public symbol` instead of `string`).
 * Callers treat this as "no decodable string" and fall back to manual
 * entry rather than guessing at padding/encoding and mis-decoding.
 */
export class LegacyBytes32Error extends Error {
  constructor() {
    super(
      'This token returns its metadata as a legacy bytes32 value, not an ABI ' +
        'string; enter the symbol and name manually.',
    );
    this.name = 'LegacyBytes32Error';
  }
}

/**
 * Minimal UTF-8 decoder (RFC 3629), used instead of TextDecoder because
 * Hermes' support for TextDecoder could not be verified for this Expo SDK,
 * and token metadata is small enough that a hand-checked 30-line decoder is
 * the lower-risk choice. Rejects invalid sequences outright: truncated
 * multi-byte sequences, stray continuation bytes, overlong encodings,
 * UTF-16 surrogate code points, and values above U+10FFFF all throw, so a
 * garbage symbol can never render as a plausible-looking string.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let codePoint: number;
    let extra: number; // number of continuation bytes
    let min: number; // smallest code point this form may encode (overlong check)
    if (b0 < 0x80) {
      codePoint = b0;
      extra = 0;
      min = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      codePoint = b0 & 0x1f;
      extra = 1;
      min = 0x80;
    } else if ((b0 & 0xf0) === 0xe0) {
      codePoint = b0 & 0x0f;
      extra = 2;
      min = 0x800;
    } else if ((b0 & 0xf8) === 0xf0) {
      codePoint = b0 & 0x07;
      extra = 3;
      min = 0x10000;
    } else {
      throw new Error(`Invalid UTF-8 lead byte 0x${b0.toString(16)} at offset ${i}`);
    }
    if (i + extra >= bytes.length) {
      throw new Error('Truncated UTF-8 sequence at end of string');
    }
    for (let k = 1; k <= extra; k++) {
      const bk = bytes[i + k]!;
      if ((bk & 0xc0) !== 0x80) {
        throw new Error(`Invalid UTF-8 continuation byte at offset ${i + k}`);
      }
      codePoint = (codePoint << 6) | (bk & 0x3f);
    }
    if (codePoint < min) throw new Error('Overlong UTF-8 encoding');
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error('UTF-8 string encodes a surrogate code point');
    }
    if (codePoint > 0x10ffff) throw new Error('UTF-8 code point above U+10FFFF');
    out += String.fromCodePoint(codePoint);
    i += 1 + extra;
  }
  return out;
}

/**
 * Decodes an ABI-encoded `string` return value, e.g. from symbol() or
 * name(). Per the Solidity ABI spec, a function returning one string
 * encodes it as head/tail:
 *
 *   word 0:               offset of the string data, relative to the start
 *                         of the return data (almost always 0x20);
 *   word at offset:       the byte length of the string;
 *   bytes after that:     the UTF-8 bytes, right-padded with zeros to a
 *                         multiple of 32.
 *
 * Anything that does not fit this layout throws with a specific reason:
 *  - empty return data ("0x"): no contract at the address, or the method
 *    does not exist;
 *  - exactly 32 bytes: the legacy bytes32 convention (LegacyBytes32Error,
 *    handled by falling back to manual entry — see the class above);
 *  - offsets/lengths pointing outside the data: malformed encoding.
 */
export function decodeAbiString(result: string): string {
  const data = toBytes(result);
  if (data.length === 0) {
    throw new Error('Empty return data: not a contract, or the method is missing');
  }
  if (data.length === 32) {
    throw new LegacyBytes32Error();
  }
  if (data.length < 64) {
    throw new Error(`Malformed ABI string: ${data.length} bytes of return data`);
  }
  // Word 0: offset of the length word. Read via the engine's decodeUint256
  // (a bigint), then bounds-check before converting to a JS number.
  const offset = decodeUint256(toHex(data.slice(0, 32)));
  if (offset + 32n > BigInt(data.length)) {
    throw new Error('Malformed ABI string: offset points outside the return data');
  }
  const off = Number(offset);
  const length = decodeUint256(toHex(data.slice(off, off + 32)));
  if (BigInt(off) + 32n + length > BigInt(data.length)) {
    throw new Error('Malformed ABI string: length exceeds the return data');
  }
  return utf8Decode(data.slice(off + 32, off + 32 + Number(length)));
}

/** One eth_call read: returns the raw hex return data. */
async function ethCall(url: string, to: string, data: Uint8Array): Promise<string> {
  const transport = httpTransport(url);
  return (await transport('eth_call', [{ to, data: toHex(data) }, 'latest'])) as string;
}

export interface Erc20Metadata {
  /** From decimals(): mandatory — without it balances cannot be displayed. */
  decimals: number;
  /** From symbol(), or null when it could not be decoded (see note). */
  symbol: string | null;
  /** From name(), or null when it could not be decoded (see note). */
  name: string | null;
  /**
   * When symbol or name is null, a plain-language reason (legacy bytes32
   * metadata, reverted call, ...) for the add-token screen to show next to
   * its manual-entry fields.
   */
  note: string | null;
}

/**
 * Reads symbol()/name()/decimals() from an ERC-20 contract via eth_call.
 *
 * decimals() must answer with a valid uint8 or this throws — a token whose
 * decimals are unknown cannot have balances displayed honestly, so it
 * cannot be added. symbol() and name() are best-effort: legacy bytes32
 * tokens and contracts that revert on them yield null plus a note, and the
 * add-token flow falls back to manual entry.
 */
export async function fetchErc20Metadata(url: string, contract: string): Promise<Erc20Metadata> {
  let decimals: number;
  try {
    const raw = await ethCall(url, contract, encodeFunctionCall('decimals()', []));
    const value = decodeUint256(raw);
    // ERC-20 declares decimals as uint8; anything larger is not an ERC-20
    // answer (and would break formatUnits' padStart arithmetic).
    if (value > 255n) throw new Error(`decimals() returned ${value}, not a uint8`);
    decimals = Number(value);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not read decimals() from this address — it does not answer like ` +
        `an ERC-20 token. (${detail})`,
    );
  }

  let symbol: string | null = null;
  let name: string | null = null;
  let note: string | null = null;
  try {
    symbol = decodeAbiString(await ethCall(url, contract, encodeFunctionCall('symbol()', [])));
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
  }
  try {
    name = decodeAbiString(await ethCall(url, contract, encodeFunctionCall('name()', [])));
  } catch (e) {
    note = note ?? (e instanceof Error ? e.message : String(e));
  }
  return { decimals, symbol, name, note };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * balanceOf(owner) via the engine's calldata encoder and uint256 decoder.
 * Same single-retry discipline as fetchNativeBalance in balances.ts:
 * public endpoints flake, and one retry absorbs most transient failures.
 */
export async function fetchErc20Balance(
  url: string,
  contract: string,
  owner: string,
  retryDelayMs = 750,
): Promise<bigint> {
  const attempt = async (): Promise<bigint> =>
    decodeUint256(await ethCall(url, contract, encodeErc20BalanceOf(owner)));
  try {
    return await attempt();
  } catch {
    await sleep(retryDelayMs);
    return attempt();
  }
}

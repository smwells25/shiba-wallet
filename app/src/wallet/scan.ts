// Pure helpers for turning a scanned QR payload into a recipient-field
// candidate. Deliberately conservative: this module only STRIPS a leading
// payment-URI scheme when that scheme belongs to the chain the user is
// actively sending on; everything else is returned untouched so the send
// screen's existing engine-backed validation (validateRecipient) remains
// the single authority on what is accepted. Nothing here can widen what
// the wallet considers a valid address — a mismatched or mangled payload
// simply fails validation with the normal error message.
//
// URI forms handled (verified sources):
// - ethereum: EIP-681 (eips.ethereum.org/EIPS/eip-681, fetched 2026-09-27):
//   request = "ethereum:" [ "pay-" ] target_address [ "@" chain_id ]
//             [ "/" function_name ] [ "?" parameters ]
//   so the address candidate ends at the first of "@", "/", or "?".
// - bitcoin: BIP-21 (bitcoin:<address>[?params]) — the address ends at "?".
//   Dogecoin wallets use the same BIP-21 convention with a "dogecoin:"
//   scheme; if a payload carries anything else it fails validation anyway.
// - solana: Solana Pay (solana:<recipient>[?params]) — recipient is the
//   base58 public key, parameters follow "?".
// URI schemes are case-insensitive per RFC 3986 section 3.1, so the scheme
// comparison lowercases the prefix only (never the address body — base58
// and EIP-55 are case-sensitive).

/**
 * The payment-URI scheme conventionally used by each supported chain,
 * keyed by CAIP-2 chain id. The ids are written out literally (instead of
 * importing ./send's *_CHAIN_ID constants) so this module stays
 * dependency-free and runnable under Node's TS type stripping;
 * scripts/check-qr.mjs asserts these keys are identical to send.ts's
 * constants, so the two files cannot drift apart unnoticed.
 */
export const SCHEME_BY_CHAIN: Record<string, string> = {
  'eip155:1': 'ethereum',
  'bip122:000000000019d6689c085ae165831e93': 'bitcoin',
  'bip122:1a91e3dace36e2be3bf030a65679fe82': 'dogecoin',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
};

const EVM_CHAIN_ID = 'eip155:1';

/**
 * Extracts a recipient-address candidate from a scanned QR payload for the
 * given chain. Returns the payload trimmed but otherwise untouched unless
 * it starts with the ACTIVE chain's own URI scheme, in which case the
 * scheme is stripped and the address part is cut before any URI suffix
 * ("?" everywhere; also "@" and "/" for EIP-681 ethereum URIs, and the
 * optional EIP-681 "pay-" prefix is dropped). A payload carrying a
 * different chain's scheme is returned as-is so the caller's validation
 * rejects it with an honest error instead of this module guessing.
 */
export function extractScannedAddress(chainId: string, payload: string): string {
  const trimmed = payload.trim();
  const scheme = SCHEME_BY_CHAIN[chainId];
  if (!scheme) return trimmed;

  const prefix = `${scheme}:`;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return trimmed;

  let rest = trimmed.slice(prefix.length);
  if (chainId === EVM_CHAIN_ID && rest.toLowerCase().startsWith('pay-')) {
    rest = rest.slice(4); // EIP-681 optional "pay-" prefix
  }

  // Terminators after the address part: "?" starts parameters in all three
  // conventions; EIP-681 additionally allows "@chain_id" and
  // "/function_name" directly after the address.
  const terminators = chainId === EVM_CHAIN_ID ? ['?', '@', '/'] : ['?'];
  let end = rest.length;
  for (const t of terminators) {
    const i = rest.indexOf(t);
    if (i !== -1 && i < end) end = i;
  }
  return rest.slice(0, end);
}

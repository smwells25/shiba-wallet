import { encodeFunctionCall, selector } from './abi.js';
import { toBytes, toHex } from './encoding.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * ERC-1271: signature validation for contract accounts.
 *
 * Source: ethereum/ERCs, ERCS/erc-1271.md (status Final), read 2026-10-01
 * at commit 8dd085d159cb123f545c272c0d871a5339550e79
 * (https://eips.ethereum.org/EIPS/eip-1271):
 *  - interface: `function isValidSignature(bytes32 _hash, bytes memory
 *    _signature) public view returns (bytes4 magicValue)`;
 *  - "MUST return the bytes4 magic value 0x1626ba7e when function passes",
 *    which the text defines as bytes4(keccak256("isValidSignature(bytes32,bytes)")),
 *    i.e. the magic value equals the function selector (the tests recompute
 *    it with keccak and pin it against ethers);
 *  - the reference implementation returns 0xffffffff for an invalid
 *    signature, but the standard only requires "not the magic value", and
 *    implementations may also revert. Both are treated as invalid here.
 *  - Security considerations: no gas cap should be imposed on the call, so
 *    eth_call is made without a `gas` field (the node's default budget).
 */

export const ERC1271_IS_VALID_SIGNATURE_SIGNATURE = 'isValidSignature(bytes32,bytes)';

/** bytes4 magic value a contract returns for a valid signature [ERC-1271]. */
export const ERC1271_MAGIC_VALUE = '0x1626ba7e';

/** Calldata for isValidSignature(hash, signature). */
export function encodeIsValidSignature(hash: Uint8Array, signature: Uint8Array): Uint8Array {
  if (hash.length !== 32) throw new Error(`ERC-1271 hash must be 32 bytes, got ${hash.length}`);
  return encodeFunctionCall(ERC1271_IS_VALID_SIGNATURE_SIGNATURE, [
    { kind: 'fixedBytes', value: hash },
    { kind: 'bytes', value: signature },
  ]);
}

/**
 * Decodes an isValidSignature return value: an ABI-encoded bytes4, i.e. one
 * 32-byte word with the four bytes left-aligned and zero padding on the
 * right. Returns the bytes4 as lowercase 0x-hex. Throws on anything that is
 * not a well-formed bytes4 word (short data or non-zero padding), because a
 * malformed answer must never be read as a pass.
 */
export function decodeIsValidSignatureResult(returnData: Uint8Array): string {
  if (returnData.length < 32) {
    throw new Error(`isValidSignature returned ${returnData.length} bytes, expected a 32-byte bytes4 word`);
  }
  for (let i = 4; i < 32; i++) {
    if (returnData[i] !== 0) throw new Error('isValidSignature returned a bytes4 word with non-zero padding');
  }
  return toHex(returnData.slice(0, 4));
}

/** True only for a well-formed return whose bytes4 equals the magic value. */
export function isErc1271MagicValue(returnData: Uint8Array): boolean {
  try {
    return decodeIsValidSignatureResult(returnData) === ERC1271_MAGIC_VALUE;
  } catch {
    return false;
  }
}

export type ContractSignatureCheck =
  | { valid: true; magicValue: string }
  | {
      valid: false;
      /**
       * no-code: nothing is deployed at the address (ERC-1271 cannot apply;
       *   see ERC-6492 for counterfactual accounts);
       * rejected: the call returned a well-formed bytes4 other than the magic value;
       * reverted: the call reverted;
       * malformed-return: the call returned data that is not a bytes4 word.
       */
      reason: 'no-code' | 'rejected' | 'reverted' | 'malformed-return';
      detail: string;
    };

/**
 * Heuristic used to tell an execution revert apart from a transport failure
 * when a JsonRpcTransport throws. httpTransport surfaces JSON-RPC errors as
 * "RPC error <code>: <message> (<method>)"; geth-family nodes report reverts
 * as code 3 "execution reverted…", and other clients use messages that
 * contain "revert". Structured transports may attach the revert payload as
 * `data`. Anything else (HTTP failures, rate limits, timeouts) is not a
 * revert and must propagate, because it says nothing about the signature.
 */
export function isExecutionRevertError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 3) return true;
  const data = (error as { data?: unknown }).data;
  if (typeof data === 'string' && data.startsWith('0x')) return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /RPC error 3:/.test(message) || /revert/i.test(message);
}

function hasCode(code: unknown): boolean {
  return typeof code === 'string' && code !== '0x' && code !== '0x0' && code !== '';
}

/**
 * ERC-1271 verification of `signature` over `hash` for a DEPLOYED contract
 * account, via eth_getCode + eth_call. Read-only. Transport failures that
 * are not reverts propagate unchanged.
 */
export async function verifyContractSignature(
  transport: JsonRpcTransport,
  account: string,
  hash: Uint8Array,
  signature: Uint8Array,
  options: { blockTag?: string } = {},
): Promise<ContractSignatureCheck> {
  const blockTag = options.blockTag ?? 'latest';
  const code = await transport('eth_getCode', [account, blockTag]);
  if (!hasCode(code)) {
    return { valid: false, reason: 'no-code', detail: `No contract code at ${account}` };
  }
  let result: unknown;
  try {
    result = await transport('eth_call', [
      { to: account, data: toHex(encodeIsValidSignature(hash, signature)) },
      blockTag,
    ]);
  } catch (error) {
    if (isExecutionRevertError(error)) {
      return {
        valid: false,
        reason: 'reverted',
        detail: error instanceof Error ? error.message : 'isValidSignature reverted',
      };
    }
    throw error;
  }
  if (typeof result !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(result)) {
    return { valid: false, reason: 'malformed-return', detail: 'eth_call returned a non-hex result' };
  }
  let magic: string;
  try {
    magic = decodeIsValidSignatureResult(toBytes(result));
  } catch (error) {
    return { valid: false, reason: 'malformed-return', detail: (error as Error).message };
  }
  if (magic !== ERC1271_MAGIC_VALUE) {
    return { valid: false, reason: 'rejected', detail: `isValidSignature returned ${magic}` };
  }
  return { valid: true, magicValue: magic };
}

/** The 4-byte selector of isValidSignature, recomputed with keccak (equals the magic value). */
export const ERC1271_SELECTOR = toHex(selector(ERC1271_IS_VALID_SIGNATURE_SIGNATURE));

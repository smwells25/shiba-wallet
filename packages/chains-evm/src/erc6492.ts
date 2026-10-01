import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeSequence } from './abi.js';
import { SimulationUnsupportedError, isMethodNotFoundError } from './asset-diff.js';
import { keccak, toBytes, toHex } from './encoding.js';
import {
  ERC1271_MAGIC_VALUE,
  decodeIsValidSignatureResult,
  encodeIsValidSignature,
  isExecutionRevertError,
  verifyContractSignature,
} from './erc1271.js';
import type { JsonRpcTransport } from './rpc.js';
import { decodeRevertReason } from './simulate.js';

/**
 * ERC-6492: signature validation for predeploy (counterfactual) contracts.
 *
 * Source: ethereum/ERCs, ERCS/erc-6492.md (status Final), read 2026-10-01
 * at commit 8dd085d159cb123f545c272c0d871a5339550e79
 * (https://eips.ethereum.org/EIPS/eip-6492).
 *
 * Signer side [ERC "Signer side"]:
 *  - deployed account: a normal ERC-1271 signature;
 *  - undeployed account: concat(abi.encode((create2Factory, factoryCalldata,
 *    originalERC1271Signature), (address, bytes, bytes)), magicBytes);
 *  - deployed but not yet able to verify: the same envelope with
 *    (prepareTo, prepareData, originalERC1271Signature).
 *  - magicBytes = 0x6492649264926492649264926492649264926492649264926492649264926492
 *    ("MUST be defined as" that value).
 *
 * Verifier side, in the order the ERC mandates ("Full signature
 * verification MUST be performed in the following order"):
 *  1. signature ends with magicBytes: call the factory with factoryCalldata
 *     (deploying the account if it has no code), then isValidSignature with
 *     the unwrapped signature;
 *  2. code at the address: plain ERC-1271 isValidSignature;
 *  3. if ERC-1271 fails and the deploy call was skipped because the wallet
 *     already had code, execute factoryCalldata ("prepare") and retry;
 *  4. no code: ecrecover.
 * The reference UniversalSigValidator additionally requires a 65-byte
 * ecrecover signature with v in {27, 28}; that is mirrored here.
 *
 * Off-chain strategy chosen, and why. The ERC documents two equivalent
 * off-chain routes: "an eth_call to a multicall contract that will call the
 * factory first … then call contract.isValidSignature", and the
 * ValidateSigOffchain helper whose CREATION bytecode is executed in a
 * single deployless eth_call. The ERC text publishes only the Solidity
 * source of that helper, not compiled bytecode, so using it means trusting
 * a third party's compilation (e.g. the bytecode shipped in ox/viem or
 * Ambire's signature-validator) or adding a Solidity compiler to the build.
 * This module therefore implements the multicall route natively with the
 * standard eth_simulateV1 method (execution-apis; already used by
 * ./asset-diff.ts): one simulated block containing [factory call,
 * isValidSignature call], where the second call sees the first call's state
 * — exactly the sequencing the ERC asks for, with no opaque bytecode.
 * Trade-off: eth_simulateV1 is not served by every endpoint (a
 * SimulationUnsupportedError is thrown then), whereas the deployless route
 * works with plain eth_call on any node. verifyWithDeploylessValidator is
 * provided for that case and takes the validator bytecode as an INJECTED
 * argument, so the engine pins no unaudited bytecode; whoever supplies it
 * owns its provenance. Both routes are read-only: nothing is broadcast.
 *
 * Security notes from the ERC: a counterfactual signature stays verifiable
 * after deployment (the deployed code is consulted first, so key rotation
 * is respected), and a signature can become valid on another chain where
 * the same factory and init data exist. Callers must keep chain id and
 * account address inside the signed digest (Kernel's ERC-1271 wrapper does;
 * see kernel-account.ts).
 */

export const ERC6492_MAGIC_SUFFIX = '0x6492649264926492649264926492649264926492649264926492649264926492';
const MAGIC = toBytes(ERC6492_MAGIC_SUFFIX);

export interface Erc6492Parts {
  /** create2Factory (or prepareTo) called before isValidSignature. */
  factory: string;
  /** factoryCalldata (or prepareData). */
  factoryData: Uint8Array;
  /** The original ERC-1271 signature the deployed account validates. */
  signature: Uint8Array;
}

/** abi.encode((factory, factoryData, signature), (address, bytes, bytes)) || magicBytes. */
export function wrapErc6492Signature(parts: Erc6492Parts): Uint8Array {
  return concatBytes(
    encodeSequence([
      { kind: 'address', value: parts.factory },
      { kind: 'bytes', value: parts.factoryData },
      { kind: 'bytes', value: parts.signature },
    ]),
    MAGIC,
  );
}

/** Detection rule from the ERC: the signature ends with the 32 magic bytes. */
export function isErc6492Signature(signature: Uint8Array): boolean {
  if (signature.length < 32) return false;
  const tail = signature.subarray(signature.length - 32);
  for (let i = 0; i < 32; i++) if (tail[i] !== MAGIC[i]) return false;
  return true;
}

function readWord(data: Uint8Array, offset: number, what: string): bigint {
  if (offset < 0 || offset + 32 > data.length) throw new Error(`ERC-6492 envelope: ${what} is out of range`);
  return BigInt(toHex(data.subarray(offset, offset + 32)));
}

function readBytes(data: Uint8Array, headOffset: number, what: string): Uint8Array {
  const offset = readWord(data, headOffset, `${what} offset`);
  if (offset > BigInt(data.length)) throw new Error(`ERC-6492 envelope: ${what} offset is out of range`);
  const length = readWord(data, Number(offset), `${what} length`);
  const start = Number(offset) + 32;
  if (BigInt(start) + length > BigInt(data.length)) {
    throw new Error(`ERC-6492 envelope: ${what} length is out of range`);
  }
  return data.slice(start, start + Number(length));
}

/**
 * Splits an ERC-6492 envelope into its parts, or returns null when the
 * magic suffix is absent. Decoding is strict (the address word must have
 * clean high bytes; offsets and lengths must stay inside the data), so a
 * malformed envelope throws rather than being half-read.
 */
export function unwrapErc6492Signature(signature: Uint8Array): Erc6492Parts | null {
  if (!isErc6492Signature(signature)) return null;
  const body = signature.subarray(0, signature.length - 32);
  if (body.length < 96) throw new Error('ERC-6492 envelope is shorter than its three head words');
  for (let i = 0; i < 12; i++) {
    if (body[i] !== 0) throw new Error('ERC-6492 envelope: factory address word has dirty high bytes');
  }
  return {
    factory: toChecksumAddress(body.slice(12, 32)),
    factoryData: readBytes(body, 32, 'factoryCalldata'),
    signature: readBytes(body, 64, 'signature'),
  };
}

export type UniversalVerificationPath =
  /** 6492 envelope, account had no code: factory call then isValidSignature (simulated). */
  | 'erc6492-counterfactual'
  /** 6492 envelope, account already deployed: inner signature passed ERC-1271 directly. */
  | 'erc6492-deployed'
  /** 6492 envelope, deployed account rejected it: prepare call then retry (simulated). */
  | 'erc6492-prepare'
  /** No envelope, deployed account: plain ERC-1271. */
  | 'erc1271'
  /** No envelope, no code: ecrecover against the address. */
  | 'ecrecover';

export interface UniversalVerificationResult {
  valid: boolean;
  path: UniversalVerificationPath;
  /** Human-readable reason when invalid (revert reason, returned bytes4, …). */
  detail?: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const HEX = /^0x([0-9a-fA-F]{2})*$/;

/**
 * Runs [prepare call, isValidSignature] in one eth_simulateV1 block (the
 * second call executes on the first call's post-state) and interprets the
 * second call's return value.
 */
async function simulatePrepareThenVerify(
  transport: JsonRpcTransport,
  signer: string,
  hash: Uint8Array,
  parts: Erc6492Parts,
  blockTag: string,
): Promise<{ valid: boolean; detail?: string }> {
  const payload = {
    blockStateCalls: [
      {
        calls: [
          { from: ZERO_ADDRESS, to: parts.factory, input: toHex(parts.factoryData) },
          { from: ZERO_ADDRESS, to: signer, input: toHex(encodeIsValidSignature(hash, parts.signature)) },
        ],
      },
    ],
  };
  let result: unknown;
  try {
    result = await transport('eth_simulateV1', [payload, blockTag]);
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new SimulationUnsupportedError(
        'method-not-found',
        'This RPC endpoint does not support eth_simulateV1; ERC-6492 verification needs it ' +
          '(or use verifyWithDeploylessValidator with a validator bytecode).',
      );
    }
    throw error;
  }
  const block = Array.isArray(result) ? (result[0] as { calls?: unknown } | undefined) : undefined;
  const calls = block && Array.isArray(block.calls) ? (block.calls as Record<string, unknown>[]) : undefined;
  if (!calls || calls.length !== 2) {
    throw new SimulationUnsupportedError(
      'malformed-response',
      'eth_simulateV1 returned an unrecognized response (expected one block with two call results).',
    );
  }
  const [deploy, verify] = calls as [Record<string, unknown>, Record<string, unknown>];
  if (deploy.status !== '0x1') {
    return { valid: false, detail: `factory/prepare call failed: ${callFailureReason(deploy)}` };
  }
  if (verify.status !== '0x1') {
    return { valid: false, detail: `isValidSignature ${callFailureReason(verify)}` };
  }
  const returnData = verify.returnData;
  if (typeof returnData !== 'string' || !HEX.test(returnData)) {
    throw new SimulationUnsupportedError('malformed-response', 'eth_simulateV1 call result has no returnData');
  }
  if (returnData === '0x') {
    return {
      valid: false,
      detail: 'isValidSignature returned no data: the factory call did not leave code at the signer address',
    };
  }
  try {
    const magic = decodeIsValidSignatureResult(toBytes(returnData));
    return magic === ERC1271_MAGIC_VALUE
      ? { valid: true }
      : { valid: false, detail: `isValidSignature returned ${magic}` };
  } catch (error) {
    return { valid: false, detail: (error as Error).message };
  }
}

function callFailureReason(call: Record<string, unknown>): string {
  const error = call.error as { data?: unknown; message?: unknown } | undefined;
  if (typeof error?.data === 'string' && HEX.test(error.data) && error.data.length > 2) {
    return decodeRevertReason(error.data);
  }
  if (typeof call.returnData === 'string' && HEX.test(call.returnData) && call.returnData.length > 2) {
    return decodeRevertReason(call.returnData);
  }
  if (typeof error?.message === 'string' && error.message !== '') return error.message;
  return 'reverted without a reason';
}

/**
 * EOA path of the universal flow: a 65-byte r || s || v signature with
 * v in {27, 28} whose recovered address equals `signer` (mirrors the
 * reference UniversalSigValidator, which uses the raw ecrecover precompile
 * without a low-s rule).
 */
export function ecrecoverMatches(signer: string, hash: Uint8Array, signature: Uint8Array): { valid: boolean; detail?: string } {
  if (signature.length !== 65) {
    return { valid: false, detail: `ecrecover needs a 65-byte signature, got ${signature.length}` };
  }
  const v = signature[64]!;
  if (v !== 27 && v !== 28) return { valid: false, detail: `invalid signature v value ${v}` };
  try {
    const recovered = new Uint8Array(65);
    recovered[0] = v - 27;
    recovered.set(signature.subarray(0, 64), 1);
    const point = secp256k1.Signature.fromBytes(recovered, 'recovered').recoverPublicKey(hash);
    const uncompressed = point.toBytes(false);
    const address = toChecksumAddress(keccak(uncompressed.subarray(1)).slice(12));
    return address.toLowerCase() === signer.toLowerCase()
      ? { valid: true }
      : { valid: false, detail: `signature recovers to ${address}` };
  } catch {
    return { valid: false, detail: 'signature does not recover to any public key' };
  }
}

/**
 * Full ERC-6492 verifier-side flow (see the module comment for the order)
 * over a node transport, read-only. The simulated steps need eth_simulateV1
 * and throw SimulationUnsupportedError when the endpoint lacks it. Any
 * transport failure that is not a revert propagates unchanged.
 */
export async function verifyErc6492Signature(
  transport: JsonRpcTransport,
  signer: string,
  hash: Uint8Array,
  signature: Uint8Array,
  options: { blockTag?: string } = {},
): Promise<UniversalVerificationResult> {
  if (hash.length !== 32) throw new Error(`hash must be 32 bytes, got ${hash.length}`);
  const blockTag = options.blockTag ?? 'latest';
  const parts = unwrapErc6492Signature(signature);
  const code = await transport('eth_getCode', [signer, blockTag]);
  const deployed = typeof code === 'string' && code !== '0x' && code !== '0x0' && code !== '';

  if (parts) {
    if (!deployed) {
      const outcome = await simulatePrepareThenVerify(transport, signer, hash, parts, blockTag);
      return { path: 'erc6492-counterfactual', ...outcome };
    }
    const direct = await verifyContractSignature(transport, signer, hash, parts.signature, { blockTag });
    if (direct.valid) return { valid: true, path: 'erc6492-deployed' };
    const outcome = await simulatePrepareThenVerify(transport, signer, hash, parts, blockTag);
    return { path: 'erc6492-prepare', ...outcome };
  }

  if (deployed) {
    const check = await verifyContractSignature(transport, signer, hash, signature, { blockTag });
    return check.valid
      ? { valid: true, path: 'erc1271' }
      : { valid: false, path: 'erc1271', detail: check.detail };
  }

  return { path: 'ecrecover', ...ecrecoverMatches(signer, hash, signature) };
}

/**
 * The ERC's other off-chain route: executes a ValidateSigOffchain-style
 * contract's CREATION code in a deployless eth_call, with constructor
 * arguments abi.encode(address signer, bytes32 hash, bytes signature)
 * appended, and reads its one-byte answer (0x01 valid, 0x00 invalid) [ERC
 * "Off-chain validation"]. The bytecode is supplied by the caller; the
 * engine deliberately ships none (see the module comment). A revert inside
 * the validator (e.g. a failing deployment) is reported as invalid with the
 * reason; transport failures propagate.
 */
export async function verifyWithDeploylessValidator(
  transport: JsonRpcTransport,
  validatorBytecode: Uint8Array,
  signer: string,
  hash: Uint8Array,
  signature: Uint8Array,
  options: { blockTag?: string } = {},
): Promise<{ valid: boolean; detail?: string }> {
  if (hash.length !== 32) throw new Error(`hash must be 32 bytes, got ${hash.length}`);
  const data = concatBytes(
    validatorBytecode,
    encodeSequence([
      { kind: 'address', value: signer },
      { kind: 'fixedBytes', value: hash },
      { kind: 'bytes', value: signature },
    ]),
  );
  let result: unknown;
  try {
    result = await transport('eth_call', [{ data: toHex(data) }, options.blockTag ?? 'latest']);
  } catch (error) {
    if (isExecutionRevertError(error)) {
      return { valid: false, detail: error instanceof Error ? error.message : 'validator reverted' };
    }
    throw error;
  }
  if (result === '0x01') return { valid: true };
  if (result === '0x00') return { valid: false, detail: 'validator returned 0x00' };
  throw new Error(`Deployless validator returned ${String(result)}, expected 0x01 or 0x00`);
}

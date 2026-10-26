import { randomBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall } from './abi.js';
import { toBytes, toHex, toWord } from './encoding.js';
import {
  KERNEL_V3_3,
  encodeKernelExecute,
  encodeKernelInitData,
  predictKernelAddress,
  ERC7579_CALLTYPE_BATCH,
  ERC7579_CALLTYPE_SINGLE,
  ERC7579_EXECTYPE_DEFAULT,
} from './kernel-account.js';
import {
  recoverExternalSigner,
  requiredPrefund,
  toEthSignedMessageHash,
  type BeforeSendHook,
  type Call,
  type ExternalSignature,
  type ExternalSigningScheme,
  type PreparedExternalUserOperation,
  type SmartAccountClient,
} from './smart-account.js';
import { getUserOpHash, type UserOperation } from './userop.js';

/**
 * Cold signing for a SMART ACCOUNT (phase 23 item 5, the engine half): the
 * request an on-line device hands to an off-line owner key, the signature
 * that comes back, and their strict checks. The regular-account half (phase
 * 22 item 3, app/src/wallet/cold-signing.ts) carries an EIP-1559
 * transaction; this one carries an ERC-4337 v0.7 UserOperation for a Kernel
 * v3.3 account whose ROOT validator is the ECDSA validator, plus the
 * userOpHash and the digest the owner key signs. Like the regular half the
 * format is the wallet's own (not EIP-4527), versioned, with exact key sets.
 *
 * WHAT THE OWNER SIGNS (Kernel v3.3, tag v3.3 commit
 * cd697c7e21715d015e0643af22310a99aa17433b):
 *  - Kernel.validateUserOp decodes the nonce key; type ROOT (key 0, the
 *    engine's default lane) substitutes the root validator [src/Kernel.sol
 *    lines 243-247 at that commit]; ValidationManager._validateUserOp passes
 *    the signature unchanged to the validator unless it starts with the
 *    32-byte MAGIC_VALUE_SIG_REPLAYABLE, which this wallet never produces
 *    [src/core/ValidationManager.sol lines 300-322].
 *  - ECDSAValidator.validateUserOp accepts the owner's signature over the
 *    raw userOpHash OR over toEthSignedMessageHash(userOpHash)
 *    [src/validator/ECDSAValidator.sol lines 49-66].
 *  - The engine's createKernelAccountSpec.signUserOpHash signs the EIP-191
 *    form with v = 27/28 (packages/chains-evm/src/kernel-account.ts,
 *    signUserOpHash: withEthereumV(owner.sign(toEthSignedMessageHash(h)))).
 *    KERNEL_V3_3_ECDSA_ROOT_SCHEME reproduces exactly that (pinned byte for
 *    byte in test/cold-userop.test.ts) and NOTHING ELSE: a signature over
 *    the raw userOpHash, which the validator would also accept, is refused
 *    by this module because it is not what the request asked for.
 *
 * The userOpHash is EntryPoint v0.7's getUserOpHash (./userop.ts); it covers
 * every packed field incl. initCode, callData, both gas words, the fees and
 * paymasterAndData, but not the signature. So a signature binds the fees:
 * an operation can never be repriced after the owner signed it.
 */

export const COLD_USEROP_REQUEST_TYPE = 'shiba-wallet/cold-sign-userop-request';
export const COLD_USEROP_SIGNATURE_TYPE = 'shiba-wallet/cold-sign-userop-signature';
export const COLD_USEROP_VERSION = 1;

/** The scheme id written into requests for KERNEL_V3_3_ECDSA_ROOT_SCHEME. */
export const KERNEL_ECDSA_ROOT_SCHEME_ID = 'kernel-v3.3-ecdsa-root/eip191-userop-hash';

/**
 * Kernel v3.3 with the ECDSA validator as root (createKernelAccountSpec):
 * the owner signs keccak256("\x19Ethereum Signed Message:\n32" || userOpHash)
 * and the operation's signature is r || s || v with v = 27 + yParity.
 */
export const KERNEL_V3_3_ECDSA_ROOT_SCHEME: ExternalSigningScheme = Object.freeze({
  id: KERNEL_ECDSA_ROOT_SCHEME_ID,
  digest(userOpHash: Uint8Array): Uint8Array {
    return toEthSignedMessageHash(userOpHash);
  },
  encodeSignature(signature: ExternalSignature): Uint8Array {
    if (signature.yParity !== 0 && signature.yParity !== 1) throw new Error('yParity must be 0 or 1');
    if (signature.r.length !== 32 || signature.s.length !== 32) throw new Error('r and s must be 32 bytes');
    const out = new Uint8Array(65);
    out.set(signature.r, 0);
    out.set(signature.s, 32);
    out[64] = 27 + signature.yParity;
    return out;
  },
});

/**
 * Default lifetime of a request (a judgement, not a protocol rule): long
 * enough to walk to an off-line device and back, short enough that the
 * signed fees are still near the market. A request past its expiry is
 * refused before anything is sent.
 */
export const COLD_USEROP_DEFAULT_TTL_SECONDS = 30 * 60;
/** Longest lifetime a request may state (a judgement). */
export const COLD_USEROP_MAX_TTL_SECONDS = 24 * 60 * 60;

/** The operation's fields as the request carries them: integers in decimal, bytes in lowercase hex, absent = null. */
export interface ColdUserOpFields {
  nonce: string;
  /** EIP-55, or null for a deployed account. */
  factory: string | null;
  factoryData: string | null;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** EIP-55, or null when the account pays its own gas. */
  paymaster: string | null;
  paymasterVerificationGasLimit: string | null;
  paymasterPostOpGasLimit: string | null;
  paymasterData: string | null;
}

export interface ColdUserOpRequest {
  type: typeof COLD_USEROP_REQUEST_TYPE;
  version: typeof COLD_USEROP_VERSION;
  /** 16 random bytes, "0x" + 32 lowercase hex. */
  requestId: string;
  /** Decimal. */
  chainId: string;
  /** EIP-55. */
  entryPoint: string;
  /** The smart account, EIP-55. */
  sender: string;
  /** The owner address whose off-line key must sign, EIP-55. */
  owner: string;
  scheme: typeof KERNEL_ECDSA_ROOT_SCHEME_ID;
  /** The uint192 EntryPoint nonce key, decimal ("0" = Kernel's root lane). */
  nonceKey: string;
  /** The Kernel CREATE2 index (decimal) when the operation deploys the account, else null. */
  accountIndex: string | null;
  userOp: ColdUserOpFields;
  /** A plain sentence written by the on-line half. The signer decodes the fields itself and never trusts it. */
  summary: string;
  /** EntryPoint v0.7 getUserOpHash, recomputed and checked by every reader. */
  userOpHash: string;
  /** The digest the owner key signs under `scheme`, recomputed and checked by every reader. */
  signingDigest: string;
  /** Unix seconds, decimal. */
  createdAt: string;
  /** Unix seconds, decimal; after it the request is refused. */
  expiresAt: string;
}

export interface ColdUserOpSignaturePayload {
  type: typeof COLD_USEROP_SIGNATURE_TYPE;
  version: typeof COLD_USEROP_VERSION;
  requestId: string;
  /** The address the signer signed with, EIP-55. */
  signer: string;
  userOpHash: string;
  signingDigest: string;
  yParity: 0 | 1;
  r: string;
  s: string;
}

/** Thrown for every refusal in this module; the message is a plain sentence for the screen. */
export class ColdUserOpRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColdUserOpRefusedError';
  }
}

export const COLD_USEROP_7702_REFUSAL =
  'This request carries an EIP-7702 authorization. The wallet never asks an off-line signer to sign an ' +
  'authorization, so it was refused. Nothing was signed or sent.';
export const COLD_USEROP_NOT_A_REQUEST =
  'This is not a Shiba Wallet smart-account signing request. Scan or paste the request the on-line wallet shows.';
export const COLD_USEROP_NOT_A_SIGNATURE =
  'This is not a Shiba Wallet smart-account signature. Nothing was sent. Scan the code the off-line signer shows ' +
  'after it signs.';
export const COLD_USEROP_IS_THE_REQUEST =
  'This is the signing request itself, not its signature. Nothing was sent. Scan the code the off-line signer shows ' +
  'after it has signed.';
export const COLD_USEROP_OTHER_REQUEST =
  'This signature belongs to another signing request, not the one shown on this screen, so it was refused. Nothing ' +
  'was sent.';
export const COLD_USEROP_HASH_MISMATCH =
  'The off-line signer signed a different operation from the one shown here (the userOpHash or the signing digest ' +
  'differs), so the signature was refused. Nothing was sent.';
export const COLD_USEROP_EXPIRED =
  'This signing request has expired, so it was refused. Nothing was sent. Its network fees were fixed when it was ' +
  'prepared and cannot be changed after signing; prepare a new request.';

export function coldUserOpWrongSigner(signer: string, owner: string): string {
  return (
    `This signature was made by ${signer}, not by the owner ${owner}, so it was refused. Nothing was sent. Sign with ` +
    "the owner's key."
  );
}

export function coldUserOpUnreadable(detail: string): string {
  return `The signature could not be read (${detail}), so it was refused. Nothing was sent.`;
}

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const HEX_DATA = /^0x([0-9a-f]{2})*$/;
const HASH32 = /^0x[0-9a-f]{64}$/;
const REQUEST_ID = /^0x[0-9a-f]{32}$/;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT192_LIMIT = 1n << 192n;

function checksummed(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return toChecksumAddress(toBytes(address.toLowerCase()));
}

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** True when `value` (any depth) holds a key that names an EIP-7702 authorization. */
function mentions7702(value: unknown, depth = 0): boolean {
  if (depth > 4 || typeof value !== 'object' || value === null) return false;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/^(eip7702auth|authorizationlist|authorization_list|authorization)$/i.test(key)) return true;
    if (mentions7702(inner, depth + 1)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Kernel execute calldata, decoded for the signer's screen
// ---------------------------------------------------------------------------

const EXECUTE_SELECTOR = '0xe9ae5c53'; // keccak256("execute(bytes32,bytes)")[0:4], pinned in the tests

function word(data: Uint8Array, offset: number): bigint {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > data.length) throw new Error('out of range');
  return BigInt(toHex(data.slice(offset, offset + 32)));
}

function smallWord(data: Uint8Array, offset: number): number {
  const value = word(data, offset);
  if (value > BigInt(data.length)) throw new Error('offset or length out of range');
  return Number(value);
}

function sliceBytes(data: Uint8Array, offset: number): Uint8Array {
  const length = smallWord(data, offset);
  if (offset + 32 + length > data.length) throw new Error('bytes out of range');
  return data.slice(offset + 32, offset + 32 + length);
}

/**
 * The calls inside a Kernel v3.3 execute(bytes32 mode, bytes executionCalldata)
 * callData, as the engine builds it (encodeKernelExecute, default exec
 * type). STRICT: the result is re-encoded with encodeKernelExecute and must
 * equal `callData` byte for byte, so a non-canonical or foreign encoding
 * (executeFromExecutor, executeUserOp, a try-mode batch, trailing bytes) is
 * refused rather than half-read. Throws on anything else.
 */
export function decodeKernelExecuteCalls(callData: Uint8Array): Call[] {
  const refuse = (why: string): never => {
    throw new ColdUserOpRefusedError(
      `The operation's call data is not a Kernel execute call this wallet builds (${why}), so it cannot be shown ` +
        'to the signer and was refused.',
    );
  };
  if (callData.length < 4 || toHex(callData.slice(0, 4)) !== EXECUTE_SELECTOR) refuse('unknown function');
  const args = callData.slice(4);
  let calls: Call[] = [];
  try {
    const mode = args.slice(0, 32);
    const executionCalldata = sliceBytes(args, smallWord(args, 32));
    const callType = mode[0];
    if (mode[1] !== ERC7579_EXECTYPE_DEFAULT) refuse('not the default execution type');
    if (callType === ERC7579_CALLTYPE_SINGLE) {
      if (executionCalldata.length < 52) refuse('short single call');
      calls = [
        {
          to: toChecksumAddress(executionCalldata.slice(0, 20)),
          value: BigInt(toHex(executionCalldata.slice(20, 52))),
          data: executionCalldata.slice(52),
        },
      ];
    } else if (callType === ERC7579_CALLTYPE_BATCH) {
      const arrayStart = smallWord(executionCalldata, 0);
      const count = smallWord(executionCalldata, arrayStart);
      if (count === 0 || count > 64) refuse('batch size');
      const elements = arrayStart + 32;
      for (let i = 0; i < count; i++) {
        const tuple = elements + smallWord(executionCalldata, elements + 32 * i);
        const target = word(executionCalldata, tuple);
        if (target >> 160n !== 0n) refuse('dirty address word');
        calls.push({
          to: toChecksumAddress(toBytes('0x' + target.toString(16).padStart(40, '0'))),
          value: word(executionCalldata, tuple + 32),
          data: sliceBytes(executionCalldata, tuple + smallWord(executionCalldata, tuple + 64)),
        });
      }
    } else {
      refuse('unknown call type');
    }
  } catch (e) {
    if (e instanceof ColdUserOpRefusedError) throw e;
    refuse('malformed');
  }
  const again = encodeKernelExecute(calls);
  if (toHex(again) !== toHex(callData)) refuse('not in canonical form');
  return calls;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The UserOperation a request describes (signature empty: the request never carries one). */
export function coldUserOpFromFields(sender: string, f: ColdUserOpFields): UserOperation {
  return {
    sender,
    nonce: BigInt(f.nonce),
    ...(f.factory !== null ? { factory: f.factory, factoryData: toBytes(f.factoryData ?? '0x') } : {}),
    callData: toBytes(f.callData),
    callGasLimit: BigInt(f.callGasLimit),
    verificationGasLimit: BigInt(f.verificationGasLimit),
    preVerificationGas: BigInt(f.preVerificationGas),
    maxFeePerGas: BigInt(f.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(f.maxPriorityFeePerGas),
    ...(f.paymaster !== null
      ? {
          paymaster: f.paymaster,
          ...(f.paymasterVerificationGasLimit !== null
            ? { paymasterVerificationGasLimit: BigInt(f.paymasterVerificationGasLimit) }
            : {}),
          ...(f.paymasterPostOpGasLimit !== null ? { paymasterPostOpGasLimit: BigInt(f.paymasterPostOpGasLimit) } : {}),
          paymasterData: toBytes(f.paymasterData ?? '0x'),
        }
      : {}),
    signature: new Uint8Array(0),
  };
}

function fieldsFromOperation(op: UserOperation): ColdUserOpFields {
  return {
    nonce: op.nonce.toString(),
    factory: op.factory !== undefined ? checksummed(op.factory) : null,
    factoryData: op.factory !== undefined ? toHex(op.factoryData ?? new Uint8Array(0)) : null,
    callData: toHex(op.callData),
    callGasLimit: op.callGasLimit.toString(),
    verificationGasLimit: op.verificationGasLimit.toString(),
    preVerificationGas: op.preVerificationGas.toString(),
    maxFeePerGas: op.maxFeePerGas.toString(),
    maxPriorityFeePerGas: op.maxPriorityFeePerGas.toString(),
    paymaster: op.paymaster !== undefined ? checksummed(op.paymaster) : null,
    paymasterVerificationGasLimit:
      op.paymaster !== undefined && op.paymasterVerificationGasLimit !== undefined
        ? op.paymasterVerificationGasLimit.toString()
        : null,
    paymasterPostOpGasLimit:
      op.paymaster !== undefined && op.paymasterPostOpGasLimit !== undefined ? op.paymasterPostOpGasLimit.toString() : null,
    paymasterData: op.paymaster !== undefined ? toHex(op.paymasterData ?? new Uint8Array(0)) : null,
  };
}

/** A fresh request id: 16 random bytes as "0x" + 32 lowercase hex. */
export function newColdUserOpRequestId(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('Expected 16 random bytes');
  return toHex(bytes);
}

/**
 * The request for a prepared operation (SmartAccountClient
 * .prepareUserOperationForExternalSigner with KERNEL_V3_3_ECDSA_ROOT_SCHEME).
 * `accountIndex` is the Kernel CREATE2 index and is REQUIRED when the
 * operation deploys the account, so a reader can check the factory data and
 * the sender against the owner without any network (parseColdUserOpRequest).
 * The result is read back through the strict parser before it is returned.
 */
export function buildColdUserOpRequest(
  prepared: PreparedExternalUserOperation,
  args: {
    summary: string;
    accountIndex?: bigint | null;
    nowSeconds: number;
    ttlSeconds?: number;
    requestId?: string;
  },
): ColdUserOpRequest {
  if (prepared.scheme.id !== KERNEL_ECDSA_ROOT_SCHEME_ID) {
    throw new ColdUserOpRefusedError(`Signing scheme ${prepared.scheme.id} is not one this request format carries.`);
  }
  if (prepared.userOp.eip7702Auth) throw new ColdUserOpRefusedError(COLD_USEROP_7702_REFUSAL);
  const ttl = args.ttlSeconds ?? COLD_USEROP_DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(args.nowSeconds) || args.nowSeconds <= 0) throw new Error('nowSeconds must be a positive integer');
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > COLD_USEROP_MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be between 1 and ${COLD_USEROP_MAX_TTL_SECONDS}`);
  }
  const deploys = prepared.userOp.factory !== undefined;
  if (deploys && (args.accountIndex === undefined || args.accountIndex === null)) {
    throw new Error('accountIndex is required for an operation that deploys the account');
  }
  const request: ColdUserOpRequest = {
    type: COLD_USEROP_REQUEST_TYPE,
    version: COLD_USEROP_VERSION,
    requestId: args.requestId ?? newColdUserOpRequestId(),
    chainId: prepared.chainId.toString(),
    entryPoint: checksummed(prepared.entryPoint) ?? prepared.entryPoint,
    sender: checksummed(prepared.userOp.sender) ?? prepared.userOp.sender,
    owner: checksummed(prepared.ownerAddress) ?? prepared.ownerAddress,
    scheme: KERNEL_ECDSA_ROOT_SCHEME_ID,
    nonceKey: prepared.nonceKey.toString(),
    accountIndex: deploys ? (args.accountIndex as bigint).toString() : null,
    userOp: fieldsFromOperation(prepared.userOp),
    summary: args.summary,
    userOpHash: toHex(prepared.userOpHash),
    signingDigest: toHex(prepared.signingDigest),
    createdAt: String(args.nowSeconds),
    expiresAt: String(args.nowSeconds + ttl),
  };
  return parseColdUserOpRequest(serializeColdUserOpRequest(request));
}

/** The request as text, keys in a fixed order (what QR codes, files and Copy carry). */
export function serializeColdUserOpRequest(request: ColdUserOpRequest): string {
  const u = request.userOp;
  return JSON.stringify({
    type: request.type,
    version: request.version,
    requestId: request.requestId,
    chainId: request.chainId,
    entryPoint: request.entryPoint,
    sender: request.sender,
    owner: request.owner,
    scheme: request.scheme,
    nonceKey: request.nonceKey,
    accountIndex: request.accountIndex,
    userOp: {
      nonce: u.nonce,
      factory: u.factory,
      factoryData: u.factoryData,
      callData: u.callData,
      callGasLimit: u.callGasLimit,
      verificationGasLimit: u.verificationGasLimit,
      preVerificationGas: u.preVerificationGas,
      maxFeePerGas: u.maxFeePerGas,
      maxPriorityFeePerGas: u.maxPriorityFeePerGas,
      paymaster: u.paymaster,
      paymasterVerificationGasLimit: u.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: u.paymasterPostOpGasLimit,
      paymasterData: u.paymasterData,
    },
    summary: request.summary,
    userOpHash: request.userOpHash,
    signingDigest: request.signingDigest,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });
}

const REQUEST_KEYS = [
  'type',
  'version',
  'requestId',
  'chainId',
  'entryPoint',
  'sender',
  'owner',
  'scheme',
  'nonceKey',
  'accountIndex',
  'userOp',
  'summary',
  'userOpHash',
  'signingDigest',
  'createdAt',
  'expiresAt',
] as const;
const USEROP_KEYS = [
  'nonce',
  'factory',
  'factoryData',
  'callData',
  'callGasLimit',
  'verificationGasLimit',
  'preVerificationGas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'paymaster',
  'paymasterVerificationGasLimit',
  'paymasterPostOpGasLimit',
  'paymasterData',
] as const;

/** The factory / factoryData pairs the engine's Kernel spec can produce for owner + index. */
function expectedKernelFactoryArgs(owner: string, index: bigint): Array<{ factory: string; factoryData: string }> {
  const initData = encodeKernelInitData(owner, KERNEL_V3_3.ecdsaValidator);
  const salt = toWord(index);
  return [
    {
      factory: KERNEL_V3_3.metaFactory,
      factoryData: toHex(
        encodeFunctionCall('deployWithFactory(address,bytes,bytes32)', [
          { kind: 'address', value: KERNEL_V3_3.factory },
          { kind: 'bytes', value: initData },
          { kind: 'fixedBytes', value: salt },
        ]),
      ),
    },
    {
      factory: KERNEL_V3_3.factory,
      factoryData: toHex(
        encodeFunctionCall('createAccount(bytes,bytes32)', [
          { kind: 'bytes', value: initData },
          { kind: 'fixedBytes', value: salt },
        ]),
      ),
    },
  ];
}

/**
 * Parses a request strictly, the off-line signer's side and the on-line
 * half's own self-check. Refuses: anything naming an EIP-7702
 * authorization (COLD_USEROP_7702_REFUSAL, decision D6, checked first);
 * unexpected or missing keys at either level; a version other than 1; an
 * unknown scheme; non-canonical decimals or upper-case hex; non-EIP-55
 * addresses; gas limits or fees beyond uint128 (they are packed in 128-bit
 * halves); a priority fee above the max fee; a nonce whose key part is not
 * `nonceKey`; factory / factoryData or paymaster / paymasterData given
 * without their partner; call data that is not a canonical Kernel execute
 * call (decodeKernelExecuteCalls); for a DEPLOYING operation, factory data
 * other than the Kernel v3.3 deployment of the ECDSA validator for `owner`
 * at `accountIndex`, or a sender other than that account's CREATE2 address;
 * a lifetime that is not 1 s to 24 h; and a userOpHash or signing digest
 * other than the ones recomputed from the fields.
 */
export function parseColdUserOpRequest(text: string): ColdUserOpRequest {
  const value = parseJsonObject(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ColdUserOpRefusedError(COLD_USEROP_NOT_A_REQUEST);
  }
  if ((value as Record<string, unknown>).type !== COLD_USEROP_REQUEST_TYPE) {
    throw new ColdUserOpRefusedError(COLD_USEROP_NOT_A_REQUEST);
  }
  if (mentions7702(value)) throw new ColdUserOpRefusedError(COLD_USEROP_7702_REFUSAL);
  const bad = (what: string) =>
    new ColdUserOpRefusedError(`This smart-account signing request is malformed (${what}), so it was refused.`);
  const o = objectWithKeys(value, REQUEST_KEYS);
  if (!o) throw bad('unexpected or missing fields');
  if (o.version !== COLD_USEROP_VERSION) throw bad(`version ${String(o.version)} is not supported`);
  if (typeof o.requestId !== 'string' || !REQUEST_ID.test(o.requestId)) throw bad('request id');
  if (typeof o.chainId !== 'string' || !DECIMAL.test(o.chainId) || o.chainId === '0') throw bad('chain id');
  const address = (v: unknown, what: string): string => {
    const c = typeof v === 'string' ? checksummed(v) : null;
    if (!c || c !== v) throw bad(what);
    return c;
  };
  const entryPoint = address(o.entryPoint, 'EntryPoint');
  const sender = address(o.sender, 'sender');
  const owner = address(o.owner, 'owner');
  if (o.scheme !== KERNEL_ECDSA_ROOT_SCHEME_ID) throw bad('unknown signing scheme');
  if (typeof o.nonceKey !== 'string' || !DECIMAL.test(o.nonceKey) || BigInt(o.nonceKey) >= UINT192_LIMIT) {
    throw bad('nonce key');
  }
  if (o.accountIndex !== null && (typeof o.accountIndex !== 'string' || !DECIMAL.test(o.accountIndex))) {
    throw bad('account index');
  }
  if (typeof o.summary !== 'string' || o.summary.length > 2000) throw bad('summary');
  for (const k of ['userOpHash', 'signingDigest'] as const) {
    if (typeof o[k] !== 'string' || !HASH32.test(o[k] as string)) throw bad(k);
  }
  for (const k of ['createdAt', 'expiresAt'] as const) {
    if (typeof o[k] !== 'string' || !DECIMAL.test(o[k] as string)) throw bad(k);
  }
  const created = BigInt(o.createdAt as string);
  const expires = BigInt(o.expiresAt as string);
  if (created === 0n || expires <= created || expires - created > BigInt(COLD_USEROP_MAX_TTL_SECONDS)) {
    throw bad('lifetime');
  }

  const u = objectWithKeys(o.userOp, USEROP_KEYS);
  if (!u) throw bad('operation fields');
  const decimal128 = (k: string): string => {
    const v = u[k];
    if (typeof v !== 'string' || !DECIMAL.test(v) || BigInt(v) > UINT128_MAX) throw bad(k);
    return v;
  };
  const nonce = u.nonce;
  if (typeof nonce !== 'string' || !DECIMAL.test(nonce) || BigInt(nonce) >= 1n << 256n) throw bad('nonce');
  if (BigInt(nonce) >> 64n !== BigInt(o.nonceKey)) throw bad('the nonce is not in the stated nonce key');
  const fields: ColdUserOpFields = {
    nonce,
    factory: null,
    factoryData: null,
    callData: '',
    callGasLimit: decimal128('callGasLimit'),
    verificationGasLimit: decimal128('verificationGasLimit'),
    preVerificationGas: decimal128('preVerificationGas'),
    maxFeePerGas: decimal128('maxFeePerGas'),
    maxPriorityFeePerGas: decimal128('maxPriorityFeePerGas'),
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
  };
  if (BigInt(fields.maxPriorityFeePerGas) > BigInt(fields.maxFeePerGas)) throw bad('priority fee above the max fee');
  if (typeof u.callData !== 'string' || !HEX_DATA.test(u.callData)) throw bad('call data');
  fields.callData = u.callData;
  if ((u.factory === null) !== (u.factoryData === null)) throw bad('factory without factory data');
  if (u.factory !== null) {
    fields.factory = address(u.factory, 'factory');
    if (typeof u.factoryData !== 'string' || !HEX_DATA.test(u.factoryData)) throw bad('factory data');
    fields.factoryData = u.factoryData;
  }
  if ((u.paymaster === null) !== (u.paymasterData === null)) throw bad('paymaster without paymaster data');
  if (u.paymaster !== null) {
    fields.paymaster = address(u.paymaster, 'paymaster');
    if (typeof u.paymasterData !== 'string' || !HEX_DATA.test(u.paymasterData)) throw bad('paymaster data');
    fields.paymasterData = u.paymasterData;
    if (u.paymasterVerificationGasLimit !== null) fields.paymasterVerificationGasLimit = decimal128('paymasterVerificationGasLimit');
    if (u.paymasterPostOpGasLimit !== null) fields.paymasterPostOpGasLimit = decimal128('paymasterPostOpGasLimit');
  } else if (u.paymasterVerificationGasLimit !== null || u.paymasterPostOpGasLimit !== null) {
    throw bad('paymaster gas limits without a paymaster');
  }

  decodeKernelExecuteCalls(toBytes(fields.callData));

  if (fields.factory !== null) {
    if (o.accountIndex === null) throw bad('a deploying operation needs its account index');
    const index = BigInt(o.accountIndex as string);
    const matches = expectedKernelFactoryArgs(owner, index).some(
      (e) => e.factory === fields.factory && e.factoryData === fields.factoryData,
    );
    if (!matches) {
      throw new ColdUserOpRefusedError(
        'This request deploys an account that is not the Kernel v3.3 account of its owner (the factory data ' +
          'differs from the one this wallet builds), so it was refused.',
      );
    }
    if (predictKernelAddress(owner, { index }) !== sender) {
      throw new ColdUserOpRefusedError(
        "This request's sender is not the Kernel v3.3 address of its owner at the stated index, so it was refused.",
      );
    }
  } else if (o.accountIndex !== null) {
    throw bad('an account index without a deployment');
  }

  const request: ColdUserOpRequest = {
    type: COLD_USEROP_REQUEST_TYPE,
    version: COLD_USEROP_VERSION,
    requestId: o.requestId,
    chainId: o.chainId,
    entryPoint,
    sender,
    owner,
    scheme: KERNEL_ECDSA_ROOT_SCHEME_ID,
    nonceKey: o.nonceKey,
    accountIndex: o.accountIndex as string | null,
    userOp: fields,
    summary: o.summary,
    userOpHash: o.userOpHash as string,
    signingDigest: o.signingDigest as string,
    createdAt: o.createdAt as string,
    expiresAt: o.expiresAt as string,
  };
  const hash = getUserOpHash(coldUserOpFromFields(sender, fields), entryPoint, BigInt(o.chainId));
  if (toHex(hash) !== request.userOpHash || toHex(KERNEL_V3_3_ECDSA_ROOT_SCHEME.digest(hash)) !== request.signingDigest) {
    throw new ColdUserOpRefusedError(
      'This smart-account signing request is inconsistent: its userOpHash or signing digest does not match its ' +
        'fields, so it was refused.',
    );
  }
  return request;
}

/** What an off-line signer shows, decoded from the request's FIELDS (never from its summary). */
export interface ColdUserOpDetails {
  chainId: bigint;
  sender: string;
  owner: string;
  nonce: bigint;
  /** True when the operation also deploys the account (it carries factory data). */
  deploys: boolean;
  calls: Call[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** EntryPoint v0.7 required prefund: (all gas limits) × maxFeePerGas, the most the operation can cost. */
  worstCaseFee: bigint;
  /** The paymaster, when one pays; null when the account pays its own gas. */
  paymaster: string | null;
  userOpHash: string;
  signingDigest: string;
  expiresAt: number;
}

export function coldUserOpDetails(request: ColdUserOpRequest): ColdUserOpDetails {
  const op = coldUserOpFromFields(request.sender, request.userOp);
  return {
    chainId: BigInt(request.chainId),
    sender: request.sender,
    owner: request.owner,
    nonce: op.nonce,
    deploys: op.factory !== undefined,
    calls: decodeKernelExecuteCalls(op.callData),
    maxFeePerGas: op.maxFeePerGas,
    maxPriorityFeePerGas: op.maxPriorityFeePerGas,
    worstCaseFee: requiredPrefund(op),
    paymaster: request.userOp.paymaster,
    userOpHash: request.userOpHash,
    signingDigest: request.signingDigest,
    expiresAt: Number(request.expiresAt),
  };
}

/** The prepared operation a request describes, for SmartAccountClient.submitPreparedUserOperation. */
export function preparedFromColdUserOpRequest(request: ColdUserOpRequest): PreparedExternalUserOperation {
  const strict = parseColdUserOpRequest(serializeColdUserOpRequest(request));
  return {
    ownerAddress: strict.owner,
    scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    entryPoint: strict.entryPoint,
    chainId: BigInt(strict.chainId),
    nonceKey: BigInt(strict.nonceKey),
    userOp: coldUserOpFromFields(strict.sender, strict.userOp),
    userOpHash: toBytes(strict.userOpHash),
    signingDigest: toBytes(strict.signingDigest),
  };
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

/** The off-line signer's answer for a request (scripts/testnet/cold-signer.mjs sign-userop). */
export function buildColdUserOpSignature(request: ColdUserOpRequest, signer: string, signature: ExternalSignature): string {
  const payload: ColdUserOpSignaturePayload = {
    type: COLD_USEROP_SIGNATURE_TYPE,
    version: COLD_USEROP_VERSION,
    requestId: request.requestId,
    signer: checksummed(signer) ?? signer,
    userOpHash: request.userOpHash,
    signingDigest: request.signingDigest,
    yParity: signature.yParity,
    r: toHex(signature.r),
    s: toHex(signature.s),
  };
  return JSON.stringify(payload);
}

const SIGNATURE_KEYS = ['type', 'version', 'requestId', 'signer', 'userOpHash', 'signingDigest', 'yParity', 'r', 's'] as const;

export interface ColdUserOpVerified {
  signature: ExternalSignature;
  /** The recovered signer: always the request's owner. */
  signer: string;
}

/**
 * Checks a scanned or pasted signature against the STORED request, in this
 * order, with no network: (1) it is a signature payload (the request itself
 * or other text is refused); (2) exact keys and version 1; (3) its request
 * id is the stored one; (4) its userOpHash and signing digest equal the ones
 * RECOMPUTED from the stored request's fields; (5) yParity 0 / 1, r and s
 * 32 bytes, low s; (6) its stated signer is the owner; (7) the signature
 * recovers to the owner over the recomputed digest.
 */
export function verifyColdUserOpSignature(text: string, request: ColdUserOpRequest): ColdUserOpVerified {
  const strict = parseColdUserOpRequest(serializeColdUserOpRequest(request));
  const value = parseJsonObject(text);
  const loose = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (loose?.type === COLD_USEROP_REQUEST_TYPE) throw new ColdUserOpRefusedError(COLD_USEROP_IS_THE_REQUEST);
  if (!loose || loose.type !== COLD_USEROP_SIGNATURE_TYPE) throw new ColdUserOpRefusedError(COLD_USEROP_NOT_A_SIGNATURE);
  const o = objectWithKeys(value, SIGNATURE_KEYS);
  if (!o) throw new ColdUserOpRefusedError(coldUserOpUnreadable('unexpected or missing fields'));
  if (o.version !== COLD_USEROP_VERSION) throw new ColdUserOpRefusedError(coldUserOpUnreadable(`version ${String(o.version)}`));
  if (typeof o.requestId !== 'string' || o.requestId.toLowerCase() !== strict.requestId) {
    throw new ColdUserOpRefusedError(COLD_USEROP_OTHER_REQUEST);
  }
  const hash = getUserOpHash(
    coldUserOpFromFields(strict.sender, strict.userOp),
    strict.entryPoint,
    BigInt(strict.chainId),
  );
  const digest = KERNEL_V3_3_ECDSA_ROOT_SCHEME.digest(hash);
  if (
    typeof o.userOpHash !== 'string' ||
    o.userOpHash.toLowerCase() !== toHex(hash) ||
    typeof o.signingDigest !== 'string' ||
    o.signingDigest.toLowerCase() !== toHex(digest)
  ) {
    throw new ColdUserOpRefusedError(COLD_USEROP_HASH_MISMATCH);
  }
  if (o.yParity !== 0 && o.yParity !== 1) throw new ColdUserOpRefusedError(coldUserOpUnreadable('yParity must be 0 or 1'));
  if (typeof o.r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.r)) throw new ColdUserOpRefusedError(coldUserOpUnreadable('r must be 32 bytes of hex'));
  if (typeof o.s !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.s)) throw new ColdUserOpRefusedError(coldUserOpUnreadable('s must be 32 bytes of hex'));
  const signature: ExternalSignature = { yParity: o.yParity, r: toBytes(o.r.toLowerCase()), s: toBytes(o.s.toLowerCase()) };
  const stated = typeof o.signer === 'string' ? checksummed(o.signer) : null;
  if (!stated) throw new ColdUserOpRefusedError(coldUserOpUnreadable('signer address'));
  if (stated !== strict.owner) throw new ColdUserOpRefusedError(coldUserOpWrongSigner(stated, strict.owner));
  let recovered: string;
  try {
    recovered = recoverExternalSigner(digest, signature);
  } catch (e) {
    throw new ColdUserOpRefusedError(coldUserOpUnreadable(e instanceof Error ? e.message : String(e)));
  }
  if (recovered !== strict.owner) throw new ColdUserOpRefusedError(coldUserOpWrongSigner(recovered, strict.owner));
  return { signature, signer: recovered };
}

/**
 * The whole on-line submit for a stored request and a scanned signature:
 * the expiry first (COLD_USEROP_EXPIRED, by `nowSeconds`), then
 * verifyColdUserOpSignature (no network), then
 * SmartAccountClient.submitPreparedUserOperation with `beforeSign`, which
 * repeats the signature check over the rebuilt operation before any request
 * and then runs the chain checks and the caller's fee check. Refusals from
 * the client arrive as ExternalSignatureError.
 */
export async function submitColdUserOpRequest(
  client: SmartAccountClient,
  request: ColdUserOpRequest,
  signatureText: string,
  options: { nowSeconds: number; beforeSign?: (op: UserOperation) => void | Promise<void>; beforeSend?: BeforeSendHook },
): Promise<{ userOpHash: string; userOp: UserOperation }> {
  if (!Number.isSafeInteger(options.nowSeconds)) throw new Error('nowSeconds must be an integer');
  if (BigInt(options.nowSeconds) > BigInt(request.expiresAt)) throw new ColdUserOpRefusedError(COLD_USEROP_EXPIRED);
  const verified = verifyColdUserOpSignature(signatureText, request);
  return client.submitPreparedUserOperation(preparedFromColdUserOpRequest(request), verified.signature, {
    ...(options.beforeSign ? { beforeSign: options.beforeSign } : {}),
    ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
  });
}

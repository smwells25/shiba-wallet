import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  domainSeparator,
  encodeType,
  hashStruct,
  typedDataDigest,
  type TypedDataDomain,
  type TypedDataField,
  type TypedDataTypes,
} from './eip712.js';
import { encodeFunctionCall } from './abi.js';
import { toBytes, toHex, toWord } from './encoding.js';
import { decodeIsValidSignatureResult, encodeIsValidSignature, isExecutionRevertError } from './erc1271.js';
import type { JsonRpcTransport } from './rpc.js';
import { eip191PrefixedMessage } from './smart-account.js';

/**
 * ERC-7739: readable typed signatures for smart accounts (replay-safe
 * ERC-1271 via nested EIP-712), wallet side.
 *
 * Sources, read 2026-10-01:
 *  [T] ethereum/ERCs ERCS/erc-7739.md at commit
 *      f95ce7f22bc2331e7f76a6268b7aff733cef839e (status DRAFT, created
 *      2024-05-28; https://eips.ethereum.org/EIPS/eip-7739). Being a draft,
 *      the scheme may still change; the support magic is versioned for that.
 *  [R] the ERC's reference implementation,
 *      assets/erc-7739/contracts/accounts/ERC1271.sol (solady-derived) at
 *      the same ERCs revision; used for the exact signature parsing.
 *  [5] ethereum/ERCs ERCS/erc-5267.md (eip712Domain()).
 *
 * TypedDataSign workflow [T]: when an app asks the smart account to sign
 * typed data (APP domain, contents struct), the owner key signs
 *   keccak256(0x1901 ‖ APP_DOMAIN_SEPARATOR ‖ hashStruct(TypedDataSign{
 *     contents, name, version, chainId, verifyingContract, salt }))
 * where name..salt are the ACCOUNT's eip712Domain() values, flattened into
 * the struct, and the TypedDataSign type is
 *   "TypedDataSign(" contentsName " contents,string name,string version,
 *    uint256 chainId,address verifyingContract,bytes32 salt)" ‖ contentsType.
 * That is an ordinary EIP-712 message whose primary type is TypedDataSign
 * and whose contents field has the app's struct type, so any EIP-712 signer
 * displays the app's fields (the point of the standard). The signature
 * returned to the app is
 *   originalSignature ‖ APP_DOMAIN_SEPARATOR ‖ contents ‖
 *   contentsDescription ‖ uint16(contentsDescription.length)
 * with contentsDescription = contentsType (implicit mode, when contentsType
 * starts with contentsName) or contentsType ‖ contentsName (explicit mode).
 *
 * contentsType must be exactly the bytes that, appended to the
 * "TypedDataSign(...)" prefix, reproduce EIP-712's encodeType of
 * TypedDataSign — i.e. the contents type and all its transitive
 * dependencies in EIP-712's alphabetical order. When the contents type is
 * not alphabetically first among them, contentsType does not start with
 * contentsName, which is exactly why [T] defines explicit mode ("EIP-712
 * lexicographical sorting can result in the contentsName not being
 * positioned exactly at the start of the contentsType"). This module
 * derives contentsType FROM our own encodeType of the full TypedDataSign
 * type, so the appended description and the signed digest cannot disagree.
 *
 * PersonalSign workflow [T]: for an EIP-191 message the owner signs
 *   keccak256(0x1901 ‖ ACCOUNT_DOMAIN_SEPARATOR ‖ hashStruct(PersonalSign{
 *     prefixed: "\x19Ethereum Signed Message:\n" ‖ len ‖ message }))
 * with type "PersonalSign(bytes prefixed)" (bytes are hashed per EIP-712,
 * so the struct hash is keccak256(PERSONAL_SIGN_TYPEHASH ‖ hashMessage(m)));
 * nothing is appended to the signature.
 *
 * Detection [T "Support detection"]: isValidSignature(0x7739…7739, "")
 * SHOULD return bytes4(0x77390001); the number MAY be incremented by future
 * versions.
 *
 * contentsName safety [T]: it is RECOMMENDED that accounts reject a
 * contentsName that is empty, starts with a byte in "abcdefghijklmnopqrstuvwxyz(",
 * or contains a byte in ", )\x00". The builders here refuse such requests
 * up front, because the account would reject the signature anyway and the
 * rule exists to block phishing that breaks out of the type encoding.
 *
 * Domain values: [T] uses the account's eip712Domain() values as returned
 * (ERC-5267 leaves values of absent fields unspecified; the reference
 * account returns empty strings / zero). The TypedDataSign builders
 * therefore substitute "" / 0 / address(0) / bytes32(0) for any account
 * domain field not supplied, matching the reference. Read the live values
 * with readEip712Domain when the account is deployed.
 */

const TYPED_DATA_SIGN = 'TypedDataSign';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_WORD = '0x' + '00'.repeat(32);

/** "PersonalSign(bytes prefixed)" type, per [T]. */
export const ERC7739_PERSONAL_SIGN_TYPES: TypedDataTypes = {
  PersonalSign: [{ name: 'prefixed', type: 'bytes' }],
};

/** keccak256("PersonalSign(bytes prefixed)") [T]; the reference pins 0x983e65e5…5c32de. */
export const ERC7739_PERSONAL_SIGN_TYPEHASH = toHex(keccak_256(utf8ToBytes('PersonalSign(bytes prefixed)')));

/** The hash argument that probes support [T "Support detection"]. */
export const ERC7739_SUPPORT_PROBE_HASH = '0x' + '7739'.repeat(16);

/** bytes4 an account returns to the probe for the current version of [T]. */
export const ERC7739_SUPPORT_MAGIC_V1 = '0x77390001';

function typedDataSignFields(contentsName: string): TypedDataField[] {
  return [
    { name: 'contents', type: contentsName },
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ];
}

/** What follows contentsName in the TypedDataSign type string [T]. */
const TYPED_DATA_SIGN_FIELDS_SUFFIX =
  ' contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)';

function typedDataSignPrefix(contentsName: string): string {
  return `TypedDataSign(${contentsName}${TYPED_DATA_SIGN_FIELDS_SUFFIX}`;
}

/**
 * Applies the RECOMMENDED contentsName rejection rules of [T]. Returns a
 * reason string when the name must be refused, or null when it is fine.
 */
export function erc7739ContentsNameProblem(contentsName: string): string | null {
  if (contentsName.length === 0) return 'the contents type name is empty';
  if (/^[a-z(]/.test(contentsName)) {
    return `the contents type name "${contentsName}" starts with a lowercase letter or "("`;
  }
  if (/[, )\x00]/.test(contentsName)) {
    return `the contents type name "${contentsName}" contains a comma, space, ")" or NUL`;
  }
  return null;
}

export interface Erc7739TypedData {
  /** The APP's EIP-712 domain (the contract that will call isValidSignature). */
  domain: TypedDataDomain;
  /** The app's struct types; an EIP712Domain entry, if present, is ignored. */
  types: TypedDataTypes;
  primaryType: string;
  message: Record<string, unknown>;
}

/** The account's own EIP-712 domain, as eip712Domain() reports it [5]. */
export type Erc7739AccountDomain = TypedDataDomain;

function appTypesWithoutDomain(types: TypedDataTypes): TypedDataTypes {
  const out: TypedDataTypes = {};
  for (const [name, fields] of Object.entries(types)) {
    if (name !== 'EIP712Domain') out[name] = fields;
  }
  return out;
}

export interface Erc7739ContentsDescription {
  contentsName: string;
  contentsType: string;
  mode: 'implicit' | 'explicit';
  /** The bytes appended to the signature before the uint16 length. */
  contentsDescription: string;
}

/**
 * Derives contentsName / contentsType / mode / contentsDescription for an
 * app request, refusing requests [T] tells accounts to reject and requests
 * that already define a TypedDataSign type (they would collide with the
 * wrapper type, the "cannot chain" case in [T] Security Considerations).
 */
export function erc7739ContentsDescription(
  types: TypedDataTypes,
  primaryType: string,
): Erc7739ContentsDescription {
  const appTypes = appTypesWithoutDomain(types);
  if (appTypes[TYPED_DATA_SIGN]) {
    throw new Error('The request already defines a TypedDataSign type; ERC-7739 wrapping cannot nest it');
  }
  if (primaryType === 'EIP712Domain' || !appTypes[primaryType]) {
    throw new Error(`Primary type ${primaryType} is not a struct defined in the request`);
  }
  const problem = erc7739ContentsNameProblem(primaryType);
  if (problem) throw new Error(`Refusing ERC-7739 wrapping: ${problem}`);
  const full = encodeType(
    { ...appTypes, [TYPED_DATA_SIGN]: typedDataSignFields(primaryType) },
    TYPED_DATA_SIGN,
  );
  const prefix = typedDataSignPrefix(primaryType);
  if (!full.startsWith(prefix)) {
    throw new Error('Internal error: TypedDataSign encoding does not start with its own prefix');
  }
  const contentsType = full.slice(prefix.length);
  const implicit = contentsType.startsWith(`${primaryType}(`);
  const contentsDescription = implicit ? contentsType : contentsType + primaryType;
  if (utf8ToBytes(contentsDescription).length > 0xffff) {
    throw new Error('ERC-7739 contentsDescription exceeds the uint16 length field');
  }
  return {
    contentsName: primaryType,
    contentsType,
    mode: implicit ? 'implicit' : 'explicit',
    contentsDescription,
  };
}

/**
 * The exact EIP-712 request the OWNER key signs for an ERC-7739
 * TypedDataSign signature: the app domain, the app types plus TypedDataSign,
 * primary type TypedDataSign, and the app message nested under `contents`
 * next to the account's domain values. Suitable both for display (it keeps
 * every app field readable) and for hashing with typedDataDigest.
 */
export function erc7739TypedDataSignRequest(
  request: Erc7739TypedData,
  accountDomain: Erc7739AccountDomain,
): Erc7739TypedData {
  erc7739ContentsDescription(request.types, request.primaryType); // validation
  const appTypes = appTypesWithoutDomain(request.types);
  return {
    domain: request.domain,
    types: { ...appTypes, [TYPED_DATA_SIGN]: typedDataSignFields(request.primaryType) },
    primaryType: TYPED_DATA_SIGN,
    message: {
      contents: request.message,
      name: accountDomain.name ?? '',
      version: accountDomain.version ?? '',
      chainId: accountDomain.chainId ?? 0n,
      verifyingContract: accountDomain.verifyingContract ?? ZERO_ADDRESS,
      salt: accountDomain.salt ?? ZERO_WORD,
    },
  };
}

/** The 32-byte digest the owner key signs for the TypedDataSign workflow. */
export function erc7739TypedDataSignDigest(
  request: Erc7739TypedData,
  accountDomain: Erc7739AccountDomain,
): Uint8Array {
  const nested = erc7739TypedDataSignRequest(request, accountDomain);
  return typedDataDigest(nested.domain, nested.types, nested.primaryType, nested.message);
}

/**
 * The signature returned to the app for the TypedDataSign workflow:
 * innerSignature ‖ APP_DOMAIN_SEPARATOR ‖ contents ‖ contentsDescription ‖
 * uint16(contentsDescription.length) [T]. `innerSignature` is whatever the
 * account's signature check expects for the owner (for an ECDSA-owned
 * account, the 65-byte r ‖ s ‖ v over erc7739TypedDataSignDigest).
 */
export function wrapErc7739TypedDataSignature(
  innerSignature: Uint8Array,
  request: Erc7739TypedData,
): Uint8Array {
  const { contentsDescription } = erc7739ContentsDescription(request.types, request.primaryType);
  const description = utf8ToBytes(contentsDescription);
  const length = new Uint8Array([description.length >> 8, description.length & 0xff]);
  return concatBytes(
    innerSignature,
    domainSeparator(request.domain),
    hashStruct(appTypesWithoutDomain(request.types), request.primaryType, request.message),
    description,
    length,
  );
}

/**
 * The exact EIP-712 request the owner key signs for the PersonalSign
 * workflow: the ACCOUNT's domain, type PersonalSign(bytes prefixed), and
 * the full EIP-191 prefixed message as the `prefixed` bytes.
 */
export function erc7739PersonalSignRequest(
  message: Uint8Array,
  accountDomain: Erc7739AccountDomain,
): Erc7739TypedData {
  return {
    domain: accountDomain,
    types: ERC7739_PERSONAL_SIGN_TYPES,
    primaryType: 'PersonalSign',
    message: { prefixed: toHex(eip191PrefixedMessage(message)) },
  };
}

/** The 32-byte digest the owner key signs for the PersonalSign workflow. */
export function erc7739PersonalSignDigest(
  message: Uint8Array,
  accountDomain: Erc7739AccountDomain,
): Uint8Array {
  const request = erc7739PersonalSignRequest(message, accountDomain);
  return typedDataDigest(request.domain, request.types, request.primaryType, request.message);
}

export type Erc7739VerifierView =
  | { workflow: 'PersonalSign'; digest: Uint8Array; innerSignature: Uint8Array }
  | {
      workflow: 'TypedDataSign';
      digest: Uint8Array;
      innerSignature: Uint8Array;
      contentsName: string;
      contentsType: string;
    }
  | { workflow: 'TypedDataSign'; rejected: string };

/**
 * What an ERC-7739 account computes from isValidSignature(hash, signature):
 * a TypeScript port of the reference _erc1271IsValidSignatureViaNestedEIP712
 * [R] (workflow deduction, implicit/explicit parsing, contentsName rules).
 * The account then checks `innerSignature` against `digest` for its owner.
 * Used to self-check signatures before returning them and in tests; it is
 * NOT a substitute for asking the deployed account (ERC-1271/6492).
 */
export function erc7739VerifierView(
  hash: Uint8Array,
  signature: Uint8Array,
  accountDomain: Erc7739AccountDomain,
): Erc7739VerifierView {
  const personal = (): Erc7739VerifierView => ({
    workflow: 'PersonalSign',
    digest: keccak_256(
      concatBytes(
        new Uint8Array([0x19, 0x01]),
        domainSeparator(accountDomain),
        keccak_256(concatBytes(toBytes(ERC7739_PERSONAL_SIGN_TYPEHASH), hash)),
      ),
    ),
    innerSignature: signature,
  });
  if (signature.length < 2) return personal();
  const c = (signature[signature.length - 2]! << 8) | signature[signature.length - 1]!;
  const l = 0x42 + c;
  if (c === 0 || signature.length < l) return personal();
  const o = signature.length - l;
  const appSeparator = signature.subarray(o, o + 32);
  const contents = signature.subarray(o + 32, o + 64);
  const reconstructed = keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), appSeparator, contents));
  if (toHex(reconstructed) !== toHex(hash)) return personal();

  // Work on raw bytes, as the contract does; ')' = 0x29, '(' = 0x28.
  const description = signature.slice(o + 64, o + 64 + c);
  let nameBytes: Uint8Array;
  let typeBytes: Uint8Array;
  if (description[description.length - 1] === 0x29) {
    // Implicit mode: the name is everything before the first '('.
    typeBytes = description;
    const paren = description.indexOf(0x28);
    nameBytes = paren === -1 ? description : description.slice(0, paren);
  } else {
    // Explicit mode: the name is everything after the last ')'.
    const close = description.lastIndexOf(0x29);
    typeBytes = description.slice(0, close + 1);
    nameBytes = description.slice(close + 1);
  }
  // Byte-level rule check first (the rules are defined on bytes), then
  // decode for the returned strings.
  const latin = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
  const problem = erc7739ContentsNameProblem(latin(nameBytes));
  if (problem) return { workflow: 'TypedDataSign', rejected: problem };
  const contentsName = new TextDecoder().decode(nameBytes);
  const contentsType = new TextDecoder().decode(typeBytes);

  const typeHash = keccak_256(
    concatBytes(utf8ToBytes('TypedDataSign('), nameBytes, utf8ToBytes(TYPED_DATA_SIGN_FIELDS_SUFFIX), typeBytes),
  );
  const structHash = keccak_256(
    concatBytes(
      typeHash,
      contents,
      keccak_256(utf8ToBytes(accountDomain.name ?? '')),
      keccak_256(utf8ToBytes(accountDomain.version ?? '')),
      toWord(BigInt(accountDomain.chainId ?? 0n)),
      toWord(toBytes(accountDomain.verifyingContract ?? ZERO_ADDRESS)),
      toBytes(accountDomain.salt ?? ZERO_WORD),
    ),
  );
  return {
    workflow: 'TypedDataSign',
    digest: keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), appSeparator, structHash)),
    innerSignature: signature.slice(0, o),
    contentsName,
    contentsType,
  };
}

/**
 * Asks a DEPLOYED account whether it implements [T]: eth_call
 * isValidSignature(0x7739…7739, "") and accept a bytes4 of the form
 * 0x7739nnnn with nnnn >= 0x0001 ("MAY be incremented"). Reverts or any
 * other answer mean "no". Transport failures propagate.
 */
export async function detectErc7739Support(
  transport: JsonRpcTransport,
  account: string,
  options: { blockTag?: string } = {},
): Promise<{ supported: boolean; magicValue?: string }> {
  let result: unknown;
  try {
    result = await transport('eth_call', [
      { to: account, data: toHex(encodeIsValidSignature(toBytes(ERC7739_SUPPORT_PROBE_HASH), new Uint8Array(0))) },
      options.blockTag ?? 'latest',
    ]);
  } catch (error) {
    if (isExecutionRevertError(error)) return { supported: false };
    throw error;
  }
  if (typeof result !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(result)) return { supported: false };
  let magic: string;
  try {
    magic = decodeIsValidSignatureResult(toBytes(result));
  } catch {
    return { supported: false };
  }
  const supported = magic.startsWith('0x7739') && parseInt(magic.slice(6), 16) >= 1;
  return supported ? { supported, magicValue: magic } : { supported: false, magicValue: magic };
}

/**
 * Reads an account's EIP-712 domain via ERC-5267 eip712Domain(), returning
 * only the fields its `fields` bitmap marks present (bit i, LSB first, in
 * EIP-712 order name, version, chainId, verifyingContract, salt) [5].
 * Extensions are returned as-is; a domain with extensions cannot be hashed
 * by this engine and callers should refuse it.
 */
export async function readEip712Domain(
  transport: JsonRpcTransport,
  account: string,
  options: { blockTag?: string } = {},
): Promise<{ domain: TypedDataDomain; fields: number; extensions: bigint[] }> {
  const raw = (await transport('eth_call', [
    { to: account, data: toHex(encodeFunctionCall('eip712Domain()', [])) },
    options.blockTag ?? 'latest',
  ])) as string;
  const data = toBytes(raw);
  const word = (offset: number): bigint => {
    if (offset < 0 || offset + 32 > data.length) throw new Error('eip712Domain() returned truncated data');
    return BigInt(toHex(data.subarray(offset, offset + 32)));
  };
  const string = (head: number): string => {
    const offset = Number(word(head));
    const length = Number(word(offset));
    if (offset + 32 + length > data.length) throw new Error('eip712Domain() string is out of range');
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset + 32, offset + 32 + length));
  };
  // Head: fields (bytes1), name, version, chainId, verifyingContract, salt, extensions.
  if (data.length < 7 * 32) throw new Error('eip712Domain() returned truncated data');
  for (let i = 1; i < 32; i++) {
    if (data[i] !== 0) throw new Error('eip712Domain() fields word has non-zero padding');
  }
  const fields = data[0]!;
  const domain: TypedDataDomain = {};
  if (fields & 0x01) domain.name = string(32);
  if (fields & 0x02) domain.version = string(64);
  if (fields & 0x04) domain.chainId = word(96);
  if (fields & 0x08) {
    const addressWord = data.subarray(128, 160);
    for (let i = 0; i < 12; i++) {
      if (addressWord[i] !== 0) throw new Error('eip712Domain() verifyingContract word has dirty high bytes');
    }
    domain.verifyingContract = toChecksumAddress(addressWord.slice(12));
  }
  if (fields & 0x10) domain.salt = toHex(data.slice(160, 192));
  const extOffset = Number(word(192));
  const extLength = Number(word(extOffset));
  const extensions: bigint[] = [];
  for (let i = 0; i < extLength; i++) extensions.push(word(extOffset + 32 + i * 32));
  return { domain, fields, extensions };
}

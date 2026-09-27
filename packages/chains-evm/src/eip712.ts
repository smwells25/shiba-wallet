import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toBytes, toWord } from './encoding.js';

/**
 * EIP-712 typed structured data hashing, needed for eth_signTypedData_v4
 * (dApp permits, DEX orders, governance votes). Implements the standard's
 * encoding directly: encodeType with alphabetically-sorted transitive
 * struct dependencies, hashStruct = keccak256(typeHash || encodeData),
 * atomic values as 32-byte words, dynamic types (bytes, string) as their
 * keccak256, arrays as the keccak256 of concatenated encoded elements,
 * nested structs as their hashStruct, and the final signing digest
 * keccak256(0x19 0x01 || domainSeparator || hashStruct(message)).
 * Byte-identical output with ethers.js TypedDataEncoder is asserted in
 * tests, including the EIP-712 specification's own Mail example.
 */

export interface TypedDataField {
  name: string;
  type: string;
}

export type TypedDataTypes = Record<string, TypedDataField[]>;

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: bigint | number;
  verifyingContract?: string;
  salt?: string;
}

type Value = unknown;

const ATOMIC_RE = /^(uint|int)(\d+)$|^bytes(\d+)$|^(bool|address)$/;
const ARRAY_RE = /^(.*)\[(\d*)\]$/;

/** Collects the transitive struct dependencies of a type, per the spec. */
function dependencies(types: TypedDataTypes, primary: string, found: Set<string> = new Set()): Set<string> {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const field of types[primary]!) {
    const base = field.type.replace(/\[\d*\]$/, '');
    dependencies(types, base, found);
  }
  return found;
}

export function encodeType(types: TypedDataTypes, primary: string): string {
  const deps = [...dependencies(types, primary)].filter((d) => d !== primary).sort();
  return [primary, ...deps]
    .map((name) => {
      const fields = types[name];
      if (!fields) throw new Error(`Unknown EIP-712 type: ${name}`);
      return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
    })
    .join('');
}

export function typeHash(types: TypedDataTypes, primary: string): Uint8Array {
  return keccak_256(utf8ToBytes(encodeType(types, primary)));
}

function encodeValue(types: TypedDataTypes, type: string, value: Value): Uint8Array {
  const arrayMatch = ARRAY_RE.exec(type);
  if (arrayMatch) {
    const [, elementType, fixedLength] = arrayMatch;
    if (!Array.isArray(value)) throw new Error(`Expected an array for ${type}`);
    if (fixedLength && value.length !== Number(fixedLength)) {
      throw new Error(`Expected ${fixedLength} elements for ${type}, got ${value.length}`);
    }
    return keccak_256(
      concatBytes(...value.map((item) => encodeValue(types, elementType!, item))),
    );
  }
  if (types[type]) {
    return hashStruct(types, type, value as Record<string, Value>);
  }
  if (type === 'string') {
    return keccak_256(utf8ToBytes(String(value)));
  }
  if (type === 'bytes') {
    return keccak_256(typeof value === 'string' ? toBytes(value) : (value as Uint8Array));
  }
  const atomic = ATOMIC_RE.exec(type);
  if (!atomic) throw new Error(`Unsupported EIP-712 type: ${type}`);
  if (atomic[3] !== undefined) {
    const n = Number(atomic[3]);
    if (n < 1 || n > 32) throw new Error(`Unsupported EIP-712 type: ${type}`);
  }
  if (atomic[2] !== undefined) {
    const n = Number(atomic[2]);
    if (n < 8 || n > 256 || n % 8 !== 0) {
      throw new Error(`Unsupported EIP-712 type: ${type}`);
    }
  }
  if (type === 'bool') {
    return toWord(value ? 1n : 0n);
  }
  if (type === 'address') {
    return toWord(toBytes(value as string));
  }
  if (type.startsWith('bytes')) {
    // bytesN: right-padded to 32 bytes.
    const bytes = typeof value === 'string' ? toBytes(value) : (value as Uint8Array);
    const n = Number(type.slice(5));
    if (bytes.length !== n) throw new Error(`Expected ${n} bytes for ${type}`);
    const word = new Uint8Array(32);
    word.set(bytes, 0);
    return word;
  }
  // uintN / intN. Signed values use two's complement over 256 bits.
  let v = typeof value === 'bigint' ? value : BigInt(value as string | number);
  const bits = BigInt(atomic[2]!);
  if (type.startsWith('int')) {
    const min = -(1n << (bits - 1n));
    const max = (1n << (bits - 1n)) - 1n;
    if (v < min || v > max) throw new Error(`${type} out of range: ${v}`);
    if (v < 0n) v += 1n << 256n;
  } else {
    if (v < 0n || v >= 1n << bits) throw new Error(`${type} out of range: ${v}`);
  }
  return toWord(v);
}

export function hashStruct(
  types: TypedDataTypes,
  primary: string,
  data: Record<string, Value>,
): Uint8Array {
  const fields = types[primary];
  if (!fields) throw new Error(`Unknown EIP-712 type: ${primary}`);
  const encoded = fields.map((field) => {
    if (!(field.name in data)) {
      throw new Error(`Missing value for ${primary}.${field.name}`);
    }
    return encodeValue(types, field.type, data[field.name]);
  });
  return keccak_256(concatBytes(typeHash(types, primary), ...encoded));
}

/** EIP712Domain type built from the fields the domain actually uses. */
export function domainSeparator(domain: TypedDataDomain): Uint8Array {
  const fields: TypedDataField[] = [];
  const values: Record<string, Value> = {};
  if (domain.name !== undefined) {
    fields.push({ name: 'name', type: 'string' });
    values.name = domain.name;
  }
  if (domain.version !== undefined) {
    fields.push({ name: 'version', type: 'string' });
    values.version = domain.version;
  }
  if (domain.chainId !== undefined) {
    fields.push({ name: 'chainId', type: 'uint256' });
    values.chainId = domain.chainId;
  }
  if (domain.verifyingContract !== undefined) {
    fields.push({ name: 'verifyingContract', type: 'address' });
    values.verifyingContract = domain.verifyingContract;
  }
  if (domain.salt !== undefined) {
    fields.push({ name: 'salt', type: 'bytes32' });
    values.salt = domain.salt;
  }
  return hashStruct({ EIP712Domain: fields }, 'EIP712Domain', values);
}

/** The 32-byte digest the wallet signs for eth_signTypedData_v4. */
export function typedDataDigest(
  domain: TypedDataDomain,
  types: TypedDataTypes,
  primary: string,
  message: Record<string, Value>,
): Uint8Array {
  return keccak_256(
    concatBytes(
      new Uint8Array([0x19, 0x01]),
      domainSeparator(domain),
      hashStruct(types, primary, message),
    ),
  );
}

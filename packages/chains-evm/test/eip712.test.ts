import { describe, expect, it } from 'vitest';
import { TypedDataEncoder } from 'ethers';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  domainSeparator,
  encodeType,
  typedDataDigest,
} from '../src/eip712.js';
import { toHex } from '../src/encoding.js';

// The EIP-712 specification's own example (Mail with nested Person).
const MAIL_DOMAIN = {
  name: 'Ether Mail',
  version: '1',
  chainId: 1n,
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
};
const MAIL_TYPES = {
  Person: [
    { name: 'name', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  Mail: [
    { name: 'from', type: 'Person' },
    { name: 'to', type: 'Person' },
    { name: 'contents', type: 'string' },
  ],
};
const MAIL_MESSAGE = {
  from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
  to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
  contents: 'Hello, Bob!',
};

describe('EIP-712 vs ethers.TypedDataEncoder', () => {
  it('reproduces the spec Mail example digest', () => {
    const ours = toHex(typedDataDigest(MAIL_DOMAIN, MAIL_TYPES, 'Mail', MAIL_MESSAGE));
    expect(ours).toBe(TypedDataEncoder.hash(MAIL_DOMAIN, MAIL_TYPES, MAIL_MESSAGE));
    expect(encodeType(MAIL_TYPES, 'Mail')).toBe(
      'Mail(Person from,Person to,string contents)Person(string name,address wallet)',
    );
  });

  it('matches ethers for a permit-style message (uint256, address, deadline)', () => {
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: 1n,
      verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    };
    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const message = {
      owner: '0x1111111111111111111111111111111111111111',
      spender: '0x2222222222222222222222222222222222222222',
      value: (1n << 255n) + 7n,
      nonce: 0n,
      deadline: 1_900_000_000n,
    };
    expect(toHex(typedDataDigest(domain, types, 'Permit', message))).toBe(
      TypedDataEncoder.hash(domain, types, message),
    );
  });

  it('matches ethers for arrays, negative ints, bytes, bytesN, and bool', () => {
    const domain = { name: 'Arrays', chainId: 8453n };
    const types = {
      Inner: [{ name: 'x', type: 'int8' }],
      Outer: [
        { name: 'items', type: 'Inner[]' },
        { name: 'pair', type: 'uint256[2]' },
        { name: 'blob', type: 'bytes' },
        { name: 'tag', type: 'bytes4' },
        { name: 'ok', type: 'bool' },
      ],
    };
    const message = {
      items: [{ x: -128n }, { x: 127n }],
      pair: [1n, 2n],
      blob: '0xdeadbeef',
      tag: '0x01020304',
      ok: true,
    };
    expect(toHex(typedDataDigest(domain, types, 'Outer', message))).toBe(
      TypedDataEncoder.hash(domain, types, message),
    );
  });

  it('computes domain separators for partial domains like ethers', () => {
    const partial = { name: 'OnlyName' };
    expect(toHex(domainSeparator(partial))).toBe(TypedDataEncoder.hashDomain(partial));
    const withSalt = {
      name: 'Salted',
      salt: toHex(keccak_256(utf8ToBytes('salt'))),
    };
    expect(toHex(domainSeparator(withSalt))).toBe(TypedDataEncoder.hashDomain(withSalt));
  });

  it('rejects out-of-range and malformed values', () => {
    const types = { T: [{ name: 'v', type: 'uint8' }] };
    expect(() => typedDataDigest({}, types, 'T', { v: 256n })).toThrow(/out of range/);
    expect(() =>
      typedDataDigest({}, { T: [{ name: 'v', type: 'int8' }] }, 'T', { v: -129n }),
    ).toThrow(/out of range/);
    expect(() => typedDataDigest({}, types, 'T', {})).toThrow(/Missing value/);
    expect(() =>
      typedDataDigest({}, { T: [{ name: 'v', type: 'uint7' }] }, 'T', { v: 1n }),
    ).toThrow(/Unsupported/);
    expect(() =>
      typedDataDigest({}, { T: [{ name: 'v', type: 'bytes33' }] }, 'T', { v: '0x00' }),
    ).toThrow(/Unsupported/);
  });
});

import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import {
  decodeAddress,
  decodeUint256,
  encodeErc20Approve,
  encodeErc20BalanceOf,
  encodeErc20Transfer,
  encodeErc20TransferFrom,
} from '../src/erc20.js';
import { toHex } from '../src/encoding.js';

const erc20 = new Interface([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function balanceOf(address owner)',
]);

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

describe('ERC-20 calldata vs ethers', () => {
  it('encodes transfer identically', () => {
    expect(toHex(encodeErc20Transfer(A, 1_000_000n))).toBe(
      erc20.encodeFunctionData('transfer', [A, 1_000_000n]),
    );
  });

  it('encodes approve identically (including max uint256)', () => {
    const max = (1n << 256n) - 1n;
    expect(toHex(encodeErc20Approve(B, max))).toBe(
      erc20.encodeFunctionData('approve', [B, max]),
    );
  });

  it('encodes transferFrom identically', () => {
    expect(toHex(encodeErc20TransferFrom(A, B, 5n))).toBe(
      erc20.encodeFunctionData('transferFrom', [A, B, 5n]),
    );
  });

  it('encodes balanceOf identically', () => {
    expect(toHex(encodeErc20BalanceOf(A))).toBe(
      erc20.encodeFunctionData('balanceOf', [A]),
    );
  });
});

describe('eth_call result decoding', () => {
  it('decodes uint256 words', () => {
    expect(decodeUint256('0x' + '0'.repeat(63) + '5')).toBe(5n);
    expect(() => decodeUint256('0x1234')).toThrow(/32-byte/);
  });

  it('decodes address words with checksum', () => {
    const word = '0x' + '0'.repeat(24) + A.slice(2);
    expect(decodeAddress(word).toLowerCase()).toBe(A.toLowerCase());
  });
});

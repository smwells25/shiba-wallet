import { describe, expect, it } from 'vitest';
import { fiatValue, isZeroDecimal, jsonNumberToDecimal, parseDecimal } from '../src/decimal.js';

// Reference values below were computed independently with Python's decimal
// module (precision 200, ROUND_HALF_UP) rather than with this code.

describe('jsonNumberToDecimal', () => {
  it.each([
    ['2676.3', '2676.3'],
    ['2675.9166588303415', '2675.9166588303415'],
    ['83272', '83272'],
    ['83272.0', '83272'],
    ['0', '0'],
    ['0.000', '0'],
    ['0.093269', '0.093269'],
    ['1.23e-7', '0.000000123'],
    ['1.23E-7', '0.000000123'],
    ['5E+3', '5000'],
    ['5e3', '5000'],
    ['1e0', '1'],
    ['12.5e-1', '1.25'],
    ['0.5e1', '5'],
    ['0.0012e2', '0.12'],
    ['123e-3', '0.123'],
  ])('%s -> %s', (literal, expected) => {
    expect(jsonNumberToDecimal(literal)).toBe(expected);
  });

  it.each(['-1', '-0.5', '01', '1.', '.5', '1e', 'NaN', 'Infinity', '', ' 1', '1e999', '0x10'])(
    'rejects %j',
    (literal) => {
      expect(() => jsonNumberToDecimal(literal)).toThrow();
    },
  );
});

describe('parseDecimal', () => {
  it('parses plain decimals exactly', () => {
    expect(parseDecimal('2675.9166588303415')).toEqual({ units: 26759166588303415n, scale: 13 });
    expect(parseDecimal('7')).toEqual({ units: 7n, scale: 0 });
  });

  it.each(['-1', '1e3', '1.', '.1', '', ' 1', '1,000'])('rejects %j', (value) => {
    expect(() => parseDecimal(value)).toThrow();
  });

  it('detects zero', () => {
    expect(isZeroDecimal('0')).toBe(true);
    expect(isZeroDecimal('0.000')).toBe(true);
    expect(isZeroDecimal('0.001')).toBe(false);
  });
});

describe('fiatValue', () => {
  const ETH = '2675.9166588303415';

  it('1 wei of ETH rounds to zero and is flagged below precision', () => {
    expect(fiatValue(1n, 18, ETH)).toEqual({ value: '0.00', belowPrecision: true });
    expect(fiatValue(1n, 18, ETH, { fractionDigits: 18 }).value).toBe('0.000000000000002676');
  });

  it('zero amount is exactly zero, not below precision', () => {
    expect(fiatValue(0n, 18, ETH)).toEqual({ value: '0.00', belowPrecision: false });
  });

  it('123456789 units of 6-decimal USDC', () => {
    expect(fiatValue(123_456_789n, 6, '0.99988').value).toBe('123.44');
    expect(fiatValue(123_456_789n, 6, '1').value).toBe('123.46');
  });

  it('Dogecoin and Bitcoin amounts with full-precision prices', () => {
    expect(fiatValue(12_345_678_901n, 8, '0.09323210326398859').value).toBe('11.51');
    expect(fiatValue(123_456_789n, 8, '83250.90730785819').value).toBe('102778.90');
  });

  it('large balances keep every digit (no float)', () => {
    // 10^12 ETH: the exact value ends in .5 of a cent-less dollar.
    expect(fiatValue(10n ** 30n, 18, ETH).value).toBe('2675916658830341.50');
    expect(fiatValue(2n ** 256n - 1n, 18, ETH).value).toBe(
      '309849980550903899612563950312517314396325602176938124525945302.74',
    );
  });

  it('prices with many decimals', () => {
    const price = '0.000000123456789012345678';
    expect(fiatValue(10n ** 18n, 18, price)).toEqual({ value: '0.00', belowPrecision: true });
    expect(fiatValue(10n ** 18n, 18, price, { fractionDigits: 12 }).value).toBe('0.000000123457');
  });

  it('rounds exactly-half up (away from zero) and just-below-half down', () => {
    // 0.005 USDC at 1.00 -> 0.01; 0.004999 -> 0.00
    expect(fiatValue(5_000n, 6, '1')).toEqual({ value: '0.01', belowPrecision: false });
    expect(fiatValue(4_999n, 6, '1')).toEqual({ value: '0.00', belowPrecision: true });
    // 1.005 -> 1.01, 1.004999999 -> 1.00
    expect(fiatValue(1_005_000n, 6, '1').value).toBe('1.01');
    expect(fiatValue(1_004_999_999n, 9, '1').value).toBe('1.00');
    // A price that itself creates the half: 3 units * 0.5 = 1.5 -> "2" at 0 digits
    expect(fiatValue(3n, 0, '0.5', { fractionDigits: 0 }).value).toBe('2');
    expect(fiatValue(1n, 0, '0.49999', { fractionDigits: 0 }).value).toBe('0');
  });

  it('negative amounts round symmetrically and never print -0.00', () => {
    expect(fiatValue(-5_000n, 6, '1').value).toBe('-0.01');
    expect(fiatValue(-4_999n, 6, '1')).toEqual({ value: '0.00', belowPrecision: true });
    expect(fiatValue(-123_456_789n, 6, '1').value).toBe('-123.46');
  });

  it('pads small results to the requested fraction digits', () => {
    expect(fiatValue(1n, 0, '0.07').value).toBe('0.07');
    expect(fiatValue(1n, 0, '7', { fractionDigits: 4 }).value).toBe('7.0000');
    expect(fiatValue(1n, 0, '7', { fractionDigits: 0 }).value).toBe('7');
  });

  it('rejects invalid inputs', () => {
    expect(() => fiatValue(1n, 18, '1e3')).toThrow();
    expect(() => fiatValue(1n, 18, '-1')).toThrow();
    expect(() => fiatValue(1n, -1, '1')).toThrow();
    expect(() => fiatValue(1n, 1.5, '1')).toThrow();
    expect(() => fiatValue(1n, 18, '1', { fractionDigits: -1 })).toThrow();
  });
});

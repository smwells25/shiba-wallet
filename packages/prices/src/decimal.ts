/**
 * Exact decimal helpers. Every computation here is done on bigint integers
 * scaled by powers of ten; no floating-point arithmetic touches an amount or
 * a price, so a balance of any size keeps full precision until the single,
 * explicit rounding step at the end.
 */

const PLAIN_DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;
const JSON_NUMBER_RE = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Largest exponent accepted when expanding scientific notation. */
const MAX_EXPONENT = 400;

/**
 * An exact non-negative decimal: value = units / 10^scale.
 */
export interface ScaledDecimal {
  units: bigint;
  scale: number;
}

/**
 * Parses a plain non-negative decimal string ("123", "0.000123",
 * "2676.0077099082687"). Signs, exponents, whitespace, and empty parts
 * ("1.", ".5") are rejected.
 */
export function parseDecimal(value: string): ScaledDecimal {
  const match = PLAIN_DECIMAL_RE.exec(value);
  if (!match) throw new Error(`Not a plain non-negative decimal: ${JSON.stringify(value)}`);
  const fraction = match[2] ?? '';
  return { units: BigInt(match[1]! + fraction), scale: fraction.length };
}

/**
 * Converts a JSON number literal, exactly as it appeared in the response
 * text, into a canonical plain decimal string: no exponent, no leading zeros
 * in the integer part, no trailing zeros in the fraction. Negative literals
 * are rejected because a price is never negative.
 *
 *   "2676.3"      -> "2676.3"
 *   "1.23e-7"     -> "0.000000123"
 *   "5E+3"        -> "5000"
 *   "83272.0"     -> "83272"
 */
export function jsonNumberToDecimal(literal: string): string {
  const match = JSON_NUMBER_RE.exec(literal);
  if (!match) throw new Error(`Not a JSON number literal: ${JSON.stringify(literal)}`);
  if (match[1] === '-') throw new Error(`Negative value not allowed: ${literal}`);
  const intPart = match[2]!;
  const fracPart = match[3] ?? '';
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new Error(`Exponent out of range: ${literal}`);
  }
  // All significant digits, with the decimal point placed after `pointPos`.
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exponent;
  let whole: string;
  let fraction: string;
  if (pointPos <= 0) {
    whole = '0';
    fraction = '0'.repeat(-pointPos) + digits;
  } else if (pointPos >= digits.length) {
    whole = digits + '0'.repeat(pointPos - digits.length);
    fraction = '';
  } else {
    whole = digits.slice(0, pointPos);
    fraction = digits.slice(pointPos);
  }
  whole = whole.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** True when a plain decimal string (see parseDecimal) equals zero. */
export function isZeroDecimal(value: string): boolean {
  return parseDecimal(value).units === 0n;
}

export interface FiatValueOptions {
  /** Digits after the decimal point in the result. Default 2. */
  fractionDigits?: number;
}

export interface FiatValue {
  /**
   * The value rounded half away from zero to `fractionDigits`, as a plain
   * decimal string with exactly that many fraction digits and a leading "-"
   * for negative amounts, e.g. "3412.57", "0.00", "-0.50".
   */
  value: string;
  /**
   * True when the exact value is not zero but rounds to zero at this
   * precision, so a display can say "< $0.01" instead of a misleading
   * "$0.00".
   */
  belowPrecision: boolean;
}

/**
 * Converts an exact token amount into a fiat value.
 *
 *   amount    base units as a bigint (wei, satoshis, lamports, 10^-6 USDC)
 *   decimals  the asset's decimals (18 for ETH, 8 for BTC, 6 for USDC)
 *   price     price of ONE whole unit as a plain decimal string
 *             (PriceQuote.price)
 *
 * The exact product amount * price / 10^decimals is formed as a ratio of two
 * bigints and rounded once, half away from zero. Negative amounts (for
 * example an outgoing balance change) are supported and rounded
 * symmetrically.
 */
export function fiatValue(
  amount: bigint,
  decimals: number,
  price: string,
  options: FiatValueOptions = {},
): FiatValue {
  const fractionDigits = options.fractionDigits ?? 2;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 36) {
    throw new Error(`Invalid fractionDigits: ${fractionDigits}`);
  }
  const { units: priceUnits, scale: priceScale } = parseDecimal(price);

  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const numerator = magnitude * priceUnits * 10n ** BigInt(fractionDigits);
  const denominator = 10n ** BigInt(decimals + priceScale);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;

  const belowPrecision = quotient === 0n && numerator !== 0n;
  const digits = quotient.toString().padStart(fractionDigits + 1, '0');
  const whole = digits.slice(0, digits.length - fractionDigits);
  const fraction = digits.slice(digits.length - fractionDigits);
  const body = fractionDigits === 0 ? whole : `${whole}.${fraction}`;
  const sign = negative && quotient !== 0n ? '-' : '';
  return { value: sign + body, belowPrecision };
}

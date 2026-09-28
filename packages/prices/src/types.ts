/**
 * Vendor-neutral price interfaces.
 *
 * Assets are identified by their CAIP-19 asset id string exactly as the rest
 * of the wallet formats them (see @shiba-wallet/core formatAssetId), e.g.
 * "eip155:1/slip44:60" for native ETH or
 * "eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" for USDC. This
 * package deliberately does not depend on core: providers only need to
 * recognise the ids they can price, and anything they do not recognise is
 * simply left unpriced.
 */

export interface PriceQuote {
  /** The CAIP-19 asset id exactly as the caller supplied it. */
  assetId: string;
  /** Lowercase fiat (or reference) currency code, e.g. "usd", "eur". */
  currency: string;
  /**
   * Price of ONE whole unit of the asset (1 ETH, 1 USDC, 1 BTC), as a plain
   * non-negative decimal string with no exponent and no sign, e.g.
   * "2676.0077099082687" or "0.000000123".
   *
   * Precision caveat: vendors publish prices as JSON numbers, which are
   * binary floating-point approximations of a market value that is itself
   * an aggregate estimate. Providers in this package keep the vendor's
   * decimal literal digit for digit (no float round-trip), so the string is
   * exactly what the vendor sent, but it remains an indicative display
   * price, never an execution price.
   */
  price: string;
  /** When the vendor says the price was last updated (Unix ms), if known. */
  updatedAtMs?: number;
  /** Short provider name, e.g. "coingecko". */
  provider: string;
  /**
   * Set by cachedPriceProvider when the vendor call failed and a previously
   * fetched value is being served instead. Absent or false means fresh.
   */
  stale?: boolean;
  /** When this quote was fetched from the vendor (Unix ms); set by the cache. */
  fetchedAtMs?: number;
}

export type PriceErrorKind =
  /** HTTP 429 or an equivalent vendor rate-limit answer. */
  | 'rate-limited'
  /** Any other non-success HTTP status. */
  | 'http'
  /** The transport itself failed (offline, DNS, TLS, aborted). */
  | 'network'
  /** The vendor answered, but not in the documented shape. */
  | 'malformed';

export class PriceError extends Error {
  readonly kind: PriceErrorKind;
  /** HTTP status when the failure came from an HTTP answer. */
  readonly status: number | undefined;
  /** Vendor-requested wait before retrying (from Retry-After), in ms. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: PriceErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'PriceError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Outcome of a price lookup. Every requested asset ends up in exactly one of
 * three states:
 *
 * - in `quotes`: priced;
 * - in `failed`: the lookup for it failed (network, HTTP, rate limit,
 *   malformed answer), so its price is UNKNOWN right now — callers may retry;
 * - in neither: the provider cannot price it (unsupported chain, unknown
 *   token, testnet asset, unsupported currency). An unpriceable asset is
 *   never reported as a zero price.
 */
export interface PriceResult {
  quotes: Map<string, PriceQuote>;
  failed: Map<string, PriceError>;
}

export interface PriceProvider {
  /** Short provider name, copied into every quote. */
  readonly name: string;
  /**
   * Prices the given CAIP-19 asset ids in `currency`. Implementations must
   * not throw for vendor failures; they report them per asset in
   * `PriceResult.failed`. They may throw for invalid arguments (for
   * example a malformed currency code).
   */
  getPrices(assetIds: readonly string[], currency: string): Promise<PriceResult>;
}

/**
 * The subset of the WHATWG fetch API that providers use. The global fetch
 * satisfies it, and tests can supply a small fake.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const CURRENCY_RE = /^[a-z0-9]{2,10}$/;

/**
 * Normalises a currency code to lowercase and validates its shape. Whether a
 * vendor supports the currency is a separate question: unsupported
 * currencies simply produce no quotes.
 */
export function normalizeCurrency(currency: string): string {
  const lower = currency.trim().toLowerCase();
  if (!CURRENCY_RE.test(lower)) {
    throw new Error(`Invalid currency code: ${JSON.stringify(currency)}`);
  }
  return lower;
}
